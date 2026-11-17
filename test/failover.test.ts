import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DdgSearcher } from "../src/scraper/ddg.js";
import { FailoverSearcher } from "../src/scraper/failover.js";
import type { SearchParams, SerpRecord, VerdictKind } from "../src/types.js";

const made = vi.hoisted(() => ({ calls: [] as Record<string, string | undefined>[], egress: undefined as unknown }));
vi.mock("../src/egress/state.js", () => ({ readEgressState: () => made.egress }));
vi.mock("../src/egress/tunnel.js", () => ({
  EgressTunnel: class {
    start = async () => ({ url: "http://tok@127.0.0.1:9999" });
    close = async () => {};
  },
}));
vi.mock("../src/scraper/index.js", () => ({
  createScraper: (env: Record<string, string | undefined>) => {
    made.calls.push(env);
    return { scraper: { search: async () => ({}), health: () => ({ state: "ok" }), close: async () => {} }, describe: "fake" };
  },
}));

const P: SearchParams = { q: "x", page: 1, hl: "en" };

function record(o: { status?: "Success" | "Error"; verdict?: VerdictKind | null; error?: string } = {}): SerpRecord {
  return {
    search_metadata: {
      id: "1",
      status: o.status ?? "Success",
      created_at: "",
      total_time_taken: 0,
      google_url: null,
      page_verdict: o.verdict === undefined ? "serp" : o.verdict,
      verdict_reason: null,
    },
    search_parameters: { ...P, engine: "google", device: "desktop" },
    ...(o.error !== undefined && { error: o.error }),
  };
}

type Health = { state: "ok" | "warming" | "busy" | "down"; [k: string]: unknown };
function fake(answer: () => SerpRecord = () => record(), health: Health = { state: "ok" }) {
  const s = {
    health: vi.fn(() => s.h),
    h: health,
    search: vi.fn(async (_p: SearchParams, _sig?: AbortSignal) => answer()),
    close: vi.fn(async () => {}),
  };
  return s;
}

const refusal = () => record({ status: "Error", verdict: "sorry", error: "refused on 3 exits: sorry page" });

let fallbacks: ReturnType<typeof fake>[];
let fbAnswer: () => SerpRecord;
const makeFallback = () => {
  const f = fake(() => fbAnswer());
  fallbacks.push(f);
  return f;
};

beforeEach(() => {
  fallbacks = [];
  fbAnswer = () => record();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FailoverSearcher routing", () => {
  it("sends queries to a healthy primary and builds no fallback", async () => {
    const primary = fake();
    const f = new FailoverSearcher(primary, makeFallback);
    const r = await f.search(P);
    expect(r.search_metadata.egress).toBe("cloudflare");
    expect(primary.search).toHaveBeenCalledOnce();
    expect(fallbacks).toHaveLength(0);
  });

  it("sends queries to the fallback while the primary is down with retry_in > 0", async () => {
    const primary = fake(undefined, { state: "down", reason: "blocked", retry_in: 120 });
    const f = new FailoverSearcher(primary, makeFallback);
    const r = await f.search(P);
    expect(r.search_metadata.egress).toBe("fallback");
    expect(primary.search).not.toHaveBeenCalled();
    expect(fallbacks).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("switching to the fallback"));
  });

  it("lets the primary try when its breaker is half-open, and logs when it serves again", async () => {
    const primary = fake(undefined, { state: "down", reason: "blocked", retry_in: 60 });
    const f = new FailoverSearcher(primary, makeFallback);
    await f.search(P);
    primary.h = { state: "down", reason: "blocked", retry_in: 0 };
    const r = await f.search(P);
    expect(primary.search).toHaveBeenCalledOnce();
    expect(r.search_metadata.egress).toBe("cloudflare");
    expect(console.error).toHaveBeenCalledWith("cloudflare serving again");
  });

  it("retries a refusal on all exits once on the fallback", async () => {
    const primary = fake(refusal);
    const f = new FailoverSearcher(primary, makeFallback);
    const r = await f.search(P);
    expect(r.search_metadata.status).toBe("Success");
    expect(r.search_metadata.egress).toBe("fallback");
    expect(fallbacks[0]!.search).toHaveBeenCalledOnce();
  });

  it("retries a `scraper is down` record on the fallback, but returns the fallback's refusal as is", async () => {
    const primary = fake(() => record({ status: "Error", verdict: null, error: "scraper is down: x; retry after 0 s" }));
    fbAnswer = refusal;
    const f = new FailoverSearcher(primary, makeFallback);
    const r = await f.search(P);
    expect(r.search_metadata.egress).toBe("fallback");
    expect(r.search_metadata.page_verdict).toBe("sorry");
    expect(fallbacks[0]!.search).toHaveBeenCalledOnce();
  });

  it("does not retry non-refusal errors", async () => {
    for (const r of [
      record({ status: "Error", verdict: "unknown", error: "page not served: odd" }),
      record({ status: "Error", verdict: null, error: "connect ECONNREFUSED" }),
    ]) {
      const f = new FailoverSearcher(fake(() => r), makeFallback);
      expect((await f.search(P)).search_metadata.egress).toBe("cloudflare");
    }
    expect(fallbacks).toHaveLength(0);
  });

  it("retries unrelated results (a soft block) on the fallback", async () => {
    const f = new FailoverSearcher(fake(() => record({ status: "Error", verdict: null, error: "results unrelated to the query" })), makeFallback);
    expect((await f.search(P)).search_metadata.egress).toBe("fallback");
  });

  it("does not retry when the caller aborted", async () => {
    const ac = new AbortController();
    const primary = fake(() => {
      ac.abort();
      return refusal();
    });
    const f = new FailoverSearcher(primary, makeFallback);
    const r = await f.search(P, ac.signal);
    expect(r.search_metadata.egress).toBe("cloudflare");
    expect(fallbacks).toHaveLength(0);
  });

  it("does not retry when the primary throws on abort", async () => {
    const primary = fake(() => {
      throw new Error("aborted");
    });
    const f = new FailoverSearcher(primary, makeFallback);
    await expect(f.search(P, AbortSignal.abort())).rejects.toThrow("aborted");
    expect(fallbacks).toHaveLength(0);
  });
});

describe("FailoverSearcher nested (residential, then DuckDuckGo)", () => {
  it("keeps an egress an inner layer set", async () => {
    const ddgRecord = () => ({ ...record(), search_metadata: { ...record().search_metadata, egress: "cloudflare" as const } });
    const f = new FailoverSearcher(fake(refusal), () => fake(ddgRecord));
    expect((await f.search(P)).search_metadata.egress).toBe("cloudflare");
  });

  it("reaches the last fallback when the residential fallback refuses too, and keeps each layer's egress", async () => {
    const primary = fake(refusal);
    const residential = fake(refusal);
    const ddg = fake(() => ({ ...record(), search_metadata: { ...record().search_metadata, egress: "cloudflare" as const, engine: "duckduckgo" as const } }));
    const f = new FailoverSearcher(new FailoverSearcher(primary, () => residential), () => ddg);
    const r = await f.search(P);
    expect(r.search_metadata).toMatchObject({ status: "Success", engine: "duckduckgo", egress: "cloudflare" });
    expect([primary.search, residential.search, ddg.search].map((s) => s.mock.calls.length)).toEqual([1, 1, 1]);

    // The residential fallback serves: DuckDuckGo is not asked, the record says fallback.
    residential.search.mockImplementationOnce(async () => record());
    expect((await f.search(P)).search_metadata.egress).toBe("fallback");
    expect(ddg.search).toHaveBeenCalledOnce();

    // Primary down and the residential breaker open: still DuckDuckGo.
    primary.h = { state: "down", reason: "blocked", retry_in: 300 };
    residential.search.mockImplementationOnce(async () => record({ status: "Error", verdict: null, error: "scraper is down: x; retry after 9 s" }));
    expect((await f.search(P)).search_metadata.engine).toBe("duckduckgo");
    expect(primary.search).toHaveBeenCalledTimes(2);
    expect(ddg.search).toHaveBeenCalledTimes(2);
  });

  it("a Google record from the primary stays cloudflare and never reaches DuckDuckGo", async () => {
    const ddg = fake();
    const f = new FailoverSearcher(new FailoverSearcher(fake(), makeFallback), () => ddg);
    const r = await f.search(P);
    expect(r.search_metadata.egress).toBe("cloudflare");
    expect(r.search_metadata.engine).toBeUndefined();
    expect(ddg.search).not.toHaveBeenCalled();
  });
});

describe("FailoverSearcher fallback lifetime", () => {
  it("closes the fallback after the idle time and builds a new one on the next need", async () => {
    vi.useFakeTimers();
    const primary = fake(refusal);
    const f = new FailoverSearcher(primary, makeFallback, 600_000);
    await f.search(P);
    await vi.advanceTimersByTimeAsync(599_000);
    await f.search(P); // resets the idle timer
    await vi.advanceTimersByTimeAsync(599_000);
    expect(fallbacks[0]!.close).not.toHaveBeenCalled();
    expect(f.health().fallback.state).toBe("ok");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fallbacks[0]!.close).toHaveBeenCalledOnce();
    expect(f.health().fallback.state).toBe("idle");
    await f.search(P);
    expect(fallbacks).toHaveLength(2);
    expect(f.health().fallback.warmups).toBe(2);
  });

  it("does not close the fallback while a query runs on it", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const primary = fake(refusal);
    const f = new FailoverSearcher(primary, makeFallback, 1_000);
    await f.search(P);
    fbAnswer = () => record();
    fallbacks[0]!.search.mockImplementationOnce(() => new Promise((r) => (release = () => r(record()))));
    const slow = f.search(P);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fallbacks[0]!.close).not.toHaveBeenCalled();
    release();
    await slow;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fallbacks[0]!.close).toHaveBeenCalledOnce();
  });

  it("close() closes both", async () => {
    const primary = fake(refusal);
    const f = new FailoverSearcher(primary, makeFallback);
    await f.search(P);
    await f.close();
    expect(primary.close).toHaveBeenCalledOnce();
    expect(fallbacks[0]!.close).toHaveBeenCalledOnce();
  });
});

describe("FailoverSearcher health", () => {
  it("reports both sides and the counts", async () => {
    const primary = fake(undefined, { state: "ok", pool: 1 });
    const f = new FailoverSearcher(primary, makeFallback);
    expect(f.health()).toEqual({
      state: "ok",
      primary: { state: "ok", pool: 1 },
      fallback: { state: "idle", queries: 0, warmups: 0 },
      served: { cloudflare: 0, fallback: 0 },
    });
    await f.search(P);
    primary.h = { state: "down", reason: "blocked", retry_in: 300 };
    fbAnswer = refusal;
    await f.search(P);
    fbAnswer = () => record();
    await f.search(P);
    expect(f.health()).toEqual({
      state: "ok",
      primary: { state: "down", reason: "blocked", retry_in: 300 },
      fallback: { state: "ok", queries: 2, warmups: 1 },
      served: { cloudflare: 1, fallback: 1 },
    });
  });

  it("is ok while the primary is down and the fallback idle, and follows a warming fallback", async () => {
    const primary = fake(undefined, { state: "down", reason: "blocked", retry_in: 300 });
    const f = new FailoverSearcher(primary, makeFallback);
    expect(f.health().state).toBe("ok");
    await f.search(P);
    fallbacks[0]!.h = { state: "warming" };
    expect(f.health().state).toBe("warming");
  });
});

describe("startRuntime picks failover", () => {
  const egress = { workers: [{}, {}] };
  beforeEach(() => {
    made.calls = [];
  });

  it("wraps when the primary is cloudflare and FALLBACK_PROXY is set; the fallback starts on demand with no spares", async () => {
    const { startRuntime } = await import("../src/bootstrap.js");
    made.egress = egress;
    const rt = await startRuntime({ CACHE_TTL_S: "0", FALLBACK_PROXY: "http://user-{session}:secret@res.example:8000" });
    expect(rt.searcher).toBeInstanceOf(FailoverSearcher);
    expect(made.calls).toHaveLength(1);
    const logs = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(logs).toContain("fallback: http://res.example:8000");
    expect(logs).not.toContain("secret");
    // Force the fallback through a down primary.
    const f = rt.searcher as FailoverSearcher;
    (f as unknown as { primary: { health: () => unknown } }).primary.health = () => ({ state: "down", reason: "x", retry_in: 5 });
    await f.search(P).catch(() => {});
    expect(made.calls).toHaveLength(2);
    expect(made.calls[1]).toMatchObject({ SCRAPER_PROXY: "http://user-{session}:secret@res.example:8000", SPARE_IDENTITIES: "0" });
    await rt.close();
  });

  it("does not wrap without FALLBACK_PROXY, nor when SCRAPER_PROXY replaces cloudflare", async () => {
    const { startRuntime } = await import("../src/bootstrap.js");
    made.egress = egress;
    expect((await startRuntime({})).searcher).not.toBeInstanceOf(FailoverSearcher);
    made.egress = undefined;
    const rt = await startRuntime({ SCRAPER_PROXY: "http://h:1", FALLBACK_PROXY: "http://u:p@r:2" });
    expect(rt.searcher).not.toBeInstanceOf(FailoverSearcher);
  });

  it("ENGINE_FALLBACK without FALLBACK_PROXY: cloudflare, then DuckDuckGo", async () => {
    const { startRuntime } = await import("../src/bootstrap.js");
    made.egress = egress;
    const rt = await startRuntime({ CACHE_TTL_S: "0", ENGINE_FALLBACK: "duckduckgo" });
    const f = rt.searcher as FailoverSearcher;
    expect(f).toBeInstanceOf(FailoverSearcher);
    const inner = f as unknown as { primary: unknown; makeFallback: () => unknown };
    expect(inner.primary).not.toBeInstanceOf(FailoverSearcher);
    expect(inner.makeFallback()).toBeInstanceOf(DdgSearcher);
    expect(vi.mocked(console.error).mock.calls.flat()).toContain("engine fallback: duckduckgo, only while Google refuses");
    await rt.close();
  });

  it("ENGINE_FALLBACK with FALLBACK_PROXY: residential nested inside, DuckDuckGo last", async () => {
    const { startRuntime } = await import("../src/bootstrap.js");
    made.egress = egress;
    const rt = await startRuntime({ CACHE_TTL_S: "0", ENGINE_FALLBACK: "duckduckgo", FALLBACK_PROXY: "http://u:p@r.example:2" });
    const outer = rt.searcher as unknown as { primary: unknown; makeFallback: () => unknown };
    expect(outer.primary).toBeInstanceOf(FailoverSearcher);
    expect(outer.makeFallback()).toBeInstanceOf(DdgSearcher);
    await rt.close();
  });

  it("rejects an unknown ENGINE_FALLBACK, and ignores it without the cloudflare egress", async () => {
    const { startRuntime } = await import("../src/bootstrap.js");
    made.egress = egress;
    await expect(startRuntime({ ENGINE_FALLBACK: "bing" })).rejects.toThrow(/ENGINE_FALLBACK/);
    made.egress = undefined;
    const rt = await startRuntime({ SCRAPER_PROXY: "http://h:1", ENGINE_FALLBACK: "duckduckgo" });
    expect(rt.searcher).not.toBeInstanceOf(FailoverSearcher);
  });

  it("puts the result cache in front unless CACHE_TTL_S=0, and rejects a bad cache setting", async () => {
    const { startRuntime } = await import("../src/bootstrap.js");
    const { CachingSearcher } = await import("../src/scraper/cache.js");
    made.egress = egress;
    const rt = await startRuntime({ FALLBACK_PROXY: "http://u:p@r.example:2" });
    expect(rt.searcher).toBeInstanceOf(CachingSearcher);
    expect(rt.searcher.health().cache).toEqual({ size: 0 });
    await rt.close();
    await expect(startRuntime({ CACHE_MAX: "0" })).rejects.toThrow(/CACHE_MAX/);
  });

  it("rejects a bad FALLBACK_PROXY at startup", async () => {
    const { startRuntime } = await import("../src/bootstrap.js");
    made.egress = egress;
    await expect(startRuntime({ FALLBACK_PROXY: "nope" })).rejects.toThrow(/FALLBACK_PROXY/);
  });
});
