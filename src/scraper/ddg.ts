// DuckDuckGo as the last fallback (`ENGINE_FALLBACK=duckduckgo`), only while Google refuses.
// Its HTML endpoint needs no browser, so it runs over the Cloudflare tunnel through curl-impersonate.
//
// Page 1 only: later pages need a POST with a `vqd` token from page 1, and DuckDuckGo answers that
// POST with its anomaly page when it comes from another IP, which the Cloudflare egress always is.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ddgAnomaly, parseDdg } from "../parse/ddg.js";
import type { SearchParams, Searcher, SerpRecord, Verdict } from "../types.js";
import { CURL_BIN, CurlHttp, type HttpSide, IMPERSONATE } from "./hybrid.js";
import { type ProxyEndpoint, redact } from "./proxy.js";

export const DDG_URL = "https://html.duckduckgo.com/html/";
/** The impersonate wrapper: it sends Chrome's own header set, the only one DuckDuckGo passed in the probe. */
export const DDG_CURL = resolve(CURL_BIN, "..", `curl_${IMPERSONATE}`);
/** Least gap between two DuckDuckGo requests. */
export const DDG_GAP_MS = 2_000;
/** Down this long after an anomaly page. */
export const DDG_DOWN_MS = 600_000;

/** DuckDuckGo's region code, e.g. us-en; wt-wt (no region) without gl. */
export function ddgRegion(p: SearchParams): string {
  return p.gl ? `${p.gl.toLowerCase()}-${p.hl.toLowerCase().split(/[-_]/)[0]}` : "wt-wt";
}

export class DdgSearcher implements Searcher {
  private nextAt = -Infinity;
  private downUntil = 0;

  constructor(
    private readonly http: HttpSide,
    private readonly gapMs = DDG_GAP_MS,
    private readonly downMs = DDG_DOWN_MS,
  ) {}

  /** Through `proxy` (the Cloudflare tunnel) with the curl-impersonate wrapper. */
  static over(proxy: ProxyEndpoint): DdgSearcher {
    return new DdgSearcher(new CurlHttp(proxy, DDG_CURL));
  }

  health() {
    const retry_in = this.retryIn();
    return retry_in > 0 ? { state: "down" as const, reason: "duckduckgo anomaly page", retry_in } : { state: "ok" as const };
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SerpRecord> {
    const started = performance.now();
    if (params.page > 1) return record(params, started, null, null, { error: "duckduckgo fallback serves page 1 only" });
    const wait = this.retryIn();
    if (wait > 0) return record(params, started, null, null, { error: `duckduckgo is down: anomaly page; retry after ${wait} s` });
    const url = `${DDG_URL}?${new URLSearchParams({ q: params.q, kl: ddgRegion(params) })}`;
    try {
      const r = await this.fetch(url, signal);
      if (ddgAnomaly(r.status, r.html)) {
        this.downUntil = performance.now() + this.downMs;
        console.error(`duckduckgo down for ${Math.round(this.downMs / 1000)}s: anomaly page`);
        return record(params, started, url, { kind: "sorry", reason: "duckduckgo anomaly page" }, { error: "duckduckgo refused: anomaly page" });
      }
      return record(params, started, url, { kind: "serp", reason: "duckduckgo results" }, { organic_results: parseDdg(r.html).organic_results });
    } catch (err) {
      if (signal?.aborted) throw err;
      return record(params, started, url, null, { error: redact(err instanceof Error ? err.message : String(err)) });
    }
  }

  async close(): Promise<void> {}

  private async fetch(url: string, signal?: AbortSignal) {
    const now = performance.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.gapMs;
    if (at > now) await sleep(at - now, undefined, { signal });
    return this.http.get(url, [], signal);
  }

  private retryIn(): number {
    return Math.max(0, Math.ceil((this.downUntil - performance.now()) / 1000));
  }
}

function record(
  params: SearchParams,
  started: number,
  url: string | null,
  verdict: Verdict | null,
  o: { organic_results?: unknown[]; error?: string },
): SerpRecord {
  const total = performance.now() - started;
  return {
    search_metadata: {
      id: randomUUID().replaceAll("-", ""),
      status: o.error === undefined ? "Success" : "Error",
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      total_time_taken: Math.round(total / 10) / 100,
      google_url: url,
      page_verdict: verdict?.kind ?? null,
      verdict_reason: verdict?.reason ?? null,
      timings: { total: Math.round(total) },
      egress: "cloudflare",
      engine: "duckduckgo",
    },
    search_parameters: { ...params, engine: "google", device: "desktop" },
    ...(o.organic_results && { organic_results: o.organic_results }),
    ...(o.error !== undefined && { error: o.error }),
  };
}
