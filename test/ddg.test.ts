// DuckDuckGo HTML pages saved with curl_chrome152 (query "best hiking boots", kl us-en, 2026-11-16).
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ddgAnomaly, parseDdg } from "../src/parse/ddg.js";
import { DdgSearcher, DDG_URL } from "../src/scraper/ddg.js";
import type { Headers, HttpSide } from "../src/scraper/hybrid.js";
import type { SearchParams } from "../src/types.js";

const load = (name: string) => gunzipSync(readFileSync(new URL(`fixtures/${name}.html.gz`, import.meta.url))).toString();
const P1 = load("ddg-hiking-boots-p1");
const P2 = load("ddg-hiking-boots-p2");
const ANOMALY = '<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></body></html>';
const P: SearchParams = { q: "best hiking boots", page: 1, hl: "en", gl: "us" };

describe("parseDdg", () => {
  it("page 1: results with uddg redirects decoded, and the Next form with vqd", () => {
    const r = parseDdg(P1);
    expect(r.organic_results).toHaveLength(10);
    expect(r.organic_results.map((o) => o.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.organic_results[0]).toEqual({
      position: 1,
      title: "10 Best Hiking Boots of 2026 | Tested & Ranked - GearLab",
      link: "https://www.outdoorgearlab.com/topics/shoes-and-boots/best-hiking-boots",
      displayed_link: "www.outdoorgearlab.com/topics/shoes-and-boots/best-hiking-boots",
      snippet: expect.stringMatching(/^10 Best Hiking Boots of 2026 We trail-tested/),
    });
    for (const o of r.organic_results) expect(o.link).toMatch(/^https?:\/\/(?!duckduckgo\.com)/);
  });

  it("page 2: direct links", () => {
    const r = parseDdg(P2);
    expect(r.organic_results).toHaveLength(15);
    expect(r.organic_results[0]).toMatchObject({ position: 1, link: "https://gearjunkie.com/footwear/best-hiking-boots" });
    expect(r.organic_results.at(-1)!.position).toBe(15);
  });

  it("finds no results on the anomaly page", () => {
    expect(parseDdg(ANOMALY)).toEqual({ organic_results: [] });
  });
});

describe("ddgAnomaly", () => {
  it("is a 202 or the anomaly page, not a results page", () => {
    expect(ddgAnomaly(202, "")).toBe(true);
    expect(ddgAnomaly(200, ANOMALY)).toBe(true);
    expect(ddgAnomaly(200, P1)).toBe(false);
    expect(ddgAnomaly(200, P2)).toBe(false);
  });
});

type Call = { url: string; headers: Headers };
function fakeHttp(pages: { status: number; html: string }[]) {
  const calls: Call[] = [];
  const http: HttpSide = {
    get: async (url, headers) => {
      calls.push({ url, headers });
      const p = pages.shift() ?? { status: 200, html: P1 };
      return { url, status: p.status, html: p.html, setCookies: [] };
    },
  };
  return { http, calls };
}

describe("DdgSearcher", () => {
  beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("page 1 is one GET with q and kl, marked duckduckgo over cloudflare", async () => {
    const { http, calls } = fakeHttp([{ status: 200, html: P1 }]);
    const r = await new DdgSearcher(http, 0).search(P);
    expect(calls).toEqual([{ url: `${DDG_URL}?q=best+hiking+boots&kl=us-en`, headers: [] }]);
    expect(r.search_metadata).toMatchObject({ status: "Success", page_verdict: "serp", engine: "duckduckgo", egress: "cloudflare" });
    expect(r.organic_results).toHaveLength(10);
    expect(r.error).toBeUndefined();
  });

  it("serves page 1 only, refusing later pages without a request", async () => {
    const { http, calls } = fakeHttp([]);
    const r = await new DdgSearcher(http, 0).search({ ...P, page: 2 });
    expect(r.search_metadata.status).toBe("Error");
    expect(r.error).toBe("duckduckgo fallback serves page 1 only");
    expect(calls).toHaveLength(0);
  });

  it("an anomaly page is a sorry record, then down for 10 minutes without requests", async () => {
    const { http, calls } = fakeHttp([{ status: 202, html: ANOMALY }]);
    const ddg = new DdgSearcher(http, 0);
    const r = await ddg.search(P);
    expect(r.search_metadata).toMatchObject({ status: "Error", page_verdict: "sorry", engine: "duckduckgo" });
    expect(r.error).toBe("duckduckgo refused: anomaly page");
    const h = ddg.health();
    expect(h.state).toBe("down");
    expect(h.retry_in).toBeGreaterThan(590);
    const again = await ddg.search(P);
    expect(again.error).toMatch(/^duckduckgo is down/);
    expect(calls).toHaveLength(1);
  });

  it("is ok again after the down time", async () => {
    const { http } = fakeHttp([{ status: 202, html: ANOMALY }]);
    const ddg = new DdgSearcher(http, 0, 0);
    await ddg.search(P);
    expect(ddg.health()).toEqual({ state: "ok" });
  });

  it("keeps the gap between requests", async () => {
    const { http } = fakeHttp([]);
    const ddg = new DdgSearcher(http, 50);
    const t0 = performance.now();
    await Promise.all([ddg.search(P), ddg.search(P)]);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
  });
});
