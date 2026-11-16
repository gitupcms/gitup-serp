import { describe, expect, it } from "vitest";
import type { Runtime } from "../src/bootstrap.js";
import { type CanaryQuery, evaluate, failingQueries, QUERIES, runCanary } from "../src/cli/canary.js";
import type { SearchParams, SerpRecord } from "../src/types.js";

const n = (k: number) => Array.from({ length: k }, (_, i) => ({ position: i + 1 }));

function rec(fields: Partial<Record<string, unknown>> = {}, verdict: "serp" | "sorry" = "serp"): SerpRecord {
  return {
    search_metadata: {
      id: "x",
      status: verdict === "serp" ? "Success" : "Error",
      created_at: "",
      total_time_taken: 0,
      google_url: null,
      page_verdict: verdict,
      verdict_reason: verdict === "serp" ? null : "captcha",
    },
    search_parameters: { q: "x", page: 1, hl: "en", engine: "google", device: "desktop" },
    organic_results: n(8),
    ads: [],
    local_results: [],
    ai_overview: {},
    ...fields,
  };
}

// QUERIES: commercial, commercial, local, tech, locale, locale
const good = () => [rec({ ads: n(2) }), rec(), rec({ local_results: n(3) }), rec({ ai_overview: { text: "t" } }), rec(), rec()];
const failed = (q: CanaryQuery[], r: SerpRecord[]) => evaluate(q, r).filter((c) => !c.ok && !c.info);

describe("canary checks", () => {
  it("all pass on good pages", () => {
    expect(failed(QUERIES, good())).toEqual([]);
  });

  it("ads need only one commercial query", () => {
    const r = good();
    r[0] = rec();
    expect(failed(QUERIES, r).map((c) => c.text)).toEqual(["ads on 0 of 2 commercial queries (1 or more)"]);
    r[1] = rec({ ads: n(1) });
    expect(failed(QUERIES, r)).toEqual([]);
  });

  it("no AI Overview is info, not a failure", () => {
    const r = good();
    r[3] = rec();
    const checks = evaluate(QUERIES, r);
    expect(checks.find((c) => c.info)).toMatchObject({ ok: false, query: 3 });
    expect(failingQueries(QUERIES, checks)).toEqual([]);
  });

  it("fails on a wrong verdict, too few organic results and no local pack", () => {
    const r = good();
    r[4] = rec({ organic_results: [] }, "sorry");
    r[5] = rec({ organic_results: n(4) });
    r[2] = rec();
    const texts = failed(QUERIES, r).map((c) => c.text);
    expect(texts).toContain('"en iyi kahve makinesi": verdict sorry (captcha)');
    expect(texts).toContain('"東京 観光 おすすめ": 4 organic (5 or more)');
    expect(texts).toContain('"pizza near me": 0 local results (1 or more)');
    expect(failingQueries(QUERIES, evaluate(QUERIES, r))).toEqual([2, 4, 5]);
  });

  it("a failed ads check marks every commercial query for saving", () => {
    const r = good();
    r[0] = rec();
    expect(failingQueries(QUERIES, evaluate(QUERIES, r))).toEqual([0, 1]);
  });
});

describe("runCanary", () => {
  const run = async (live: boolean, records: SerpRecord[]) => {
    const out: string[] = [];
    let i = 0;
    let closed = false;
    const runtime: Runtime = {
      live,
      searcher: { search: async (_p: SearchParams) => records[i++]!, health: () => ({ state: "ok" }) },
      close: async () => void (closed = true),
    };
    const code = await runCanary([], { startRuntime: async () => runtime, env: {}, stdout: (s) => void out.push(s), stderr: () => {} });
    return { code, out: out.join(""), closed };
  };

  it("exits 2 without egress", async () => {
    expect(await run(false, [])).toMatchObject({ code: 2, out: "", closed: true });
  });

  it("exits 0 when all pass, 1 when one fails, with one line per check", async () => {
    const ok = await run(true, good());
    expect(ok.code).toBe(0);
    expect(ok.closed).toBe(true);
    expect(ok.out.split("\n").filter(Boolean).every((l) => l.startsWith("✓"))).toBe(true);
    const r = good();
    r[3] = rec({ organic_results: n(2) });
    const bad = await run(true, r);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('✗ "hono framework": 2 organic (5 or more)');
  });
});
