import { afterEach, describe, expect, it, vi } from "vitest";
import { CachingSearcher, cacheKey } from "../src/scraper/cache.js";
import type { SearchParams, Searcher, SerpRecord } from "../src/types.js";

function record(p: SearchParams, status: "Success" | "Error" = "Success"): SerpRecord {
  return {
    search_metadata: {
      id: "orig",
      status,
      created_at: "2026-01-01T00:00:00.000Z",
      total_time_taken: 0,
      google_url: null,
      page_verdict: "serp",
      verdict_reason: null,
    },
    search_parameters: { ...p, engine: "google", device: "desktop" },
    organic_results: [{ position: 1, title: "t" }],
  };
}

class Fake implements Searcher {
  calls = 0;
  status: "Success" | "Error" = "Success";
  gate?: Promise<void>;
  async search(p: SearchParams) {
    this.calls++;
    await this.gate;
    return record(p, this.status);
  }
  health() {
    return { state: "ok" as const };
  }
}

const P: SearchParams = { q: "shoes", page: 1, hl: "en", gl: "us" };

afterEach(() => vi.useRealTimers());

describe("CachingSearcher", () => {
  it("serves a hit as a fresh deep copy marked cached", async () => {
    const fake = new Fake();
    const c = new CachingSearcher(fake, 60_000, 10);
    const miss = await c.search(P);
    expect(miss.search_metadata.cached).toBeUndefined();
    const hit = await c.search({ ...P, q: "  shoes " });
    expect(fake.calls).toBe(1);
    expect(hit.search_metadata.cached).toBe(true);
    expect(hit.search_metadata.id).toMatch(/^[0-9a-f]{32}$/);
    expect(hit.search_metadata.created_at).not.toBe("2026-01-01T00:00:00.000Z");
    (hit.organic_results as { title: string }[])[0]!.title = "changed";
    const again = await c.search(P);
    expect((again.organic_results as { title: string }[])[0]!.title).toBe("t");
    expect(again.search_metadata.id).not.toBe(hit.search_metadata.id);
    expect(c.health()).toEqual({ state: "ok", cache: { size: 1 } });
  });

  it("keys on every search parameter", async () => {
    const fake = new Fake();
    const c = new CachingSearcher(fake, 60_000, 10);
    await c.search(P);
    await c.search({ ...P, page: 2 });
    await c.search({ ...P, tbs: "qdr:d" });
    await c.search({ ...P, links: 0 });
    expect(fake.calls).toBe(4);
    expect(cacheKey({ ...P, location: "" })).toBe(cacheKey(P));
  });

  it("expires after the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = new Fake();
    const c = new CachingSearcher(fake, 1000, 10);
    await c.search(P);
    vi.advanceTimersByTime(999);
    await c.search(P);
    expect(fake.calls).toBe(1);
    vi.advanceTimersByTime(2);
    expect((await c.search(P)).search_metadata.cached).toBeUndefined();
    expect(fake.calls).toBe(2);
  });

  it("evicts the oldest entry past CACHE_MAX", async () => {
    const fake = new Fake();
    const c = new CachingSearcher(fake, 60_000, 2);
    for (const q of ["a", "b", "c"]) await c.search({ ...P, q });
    expect(c.size).toBe(2);
    await c.search({ ...P, q: "c" });
    await c.search({ ...P, q: "b" });
    expect(fake.calls).toBe(3);
    await c.search({ ...P, q: "a" });
    expect(fake.calls).toBe(4);
  });

  it("shares one in-flight search between identical misses", async () => {
    const fake = new Fake();
    let open!: () => void;
    fake.gate = new Promise((r) => (open = r));
    const c = new CachingSearcher(fake, 60_000, 10);
    const both = Promise.all([c.search(P), c.search(P)]);
    open();
    const [a, b] = await both;
    expect(fake.calls).toBe(1);
    expect(a.search_metadata.id).not.toBe(b.search_metadata.id);
  });

  it("lets a waiter on a shared search give up on its own signal", async () => {
    const fake = new Fake();
    let open!: () => void;
    fake.gate = new Promise((r) => (open = r));
    const c = new CachingSearcher(fake, 60_000, 10);
    const first = c.search(P);
    const ac = new AbortController();
    const second = c.search(P, ac.signal);
    ac.abort(new Error("gave up"));
    await expect(second).rejects.toThrow("gave up");
    open();
    await first;
  });

  it("does not store Error records or thrown errors", async () => {
    const fake = new Fake();
    fake.status = "Error";
    const c = new CachingSearcher(fake, 60_000, 10);
    await c.search(P);
    await c.search(P);
    expect(fake.calls).toBe(2);
    expect(c.size).toBe(0);
    const thrower = new CachingSearcher({ search: async () => { throw new Error("boom"); }, health: () => ({ state: "ok" }) }, 60_000, 10);
    await expect(thrower.search(P)).rejects.toThrow("boom");
    expect(thrower.size).toBe(0);
  });
});
