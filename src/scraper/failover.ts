// Cloudflare first, a paid fallback proxy only while Cloudflare is blocked.
// Google blocks the whole Cloudflare egress range after a burst, for an hour or more; pacing does not help.

import type { SearchParams, Searcher, SerpRecord } from "../types.js";
import { redact } from "./proxy.js";

export type Closable = Searcher & { close(): Promise<void> };
type Health = ReturnType<Searcher["health"]>;

/** Seconds without a fallback query before its browsers close (`FALLBACK_IDLE_S`). */
export const FALLBACK_IDLE_S = 600;

const REFUSED = ["sorry", "wall", "block"];

/** The primary gave up on Google's refusal or its breaker: worth one try on the fallback. */
function refused(r: SerpRecord): boolean {
  const m = r.search_metadata;
  if (m.status !== "Error") return false;
  // Unrelated results are Google's soft block, so they count too.
  return (m.page_verdict !== null && REFUSED.includes(m.page_verdict)) || /^scraper is down|results unrelated/.test(r.error ?? "");
}

export class FailoverSearcher implements Searcher {
  private fallback: Closable | null = null;
  private inFlight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private onFallback = false;
  private warmups = 0;
  /** Every query sent to the fallback, served or not: what the paid proxy saw. */
  private fallbackQueries = 0;
  private readonly served = { cloudflare: 0, fallback: 0 };

  /** `makeFallback` builds a fresh fallback scraper; it runs on first need, never at startup. */
  constructor(
    private readonly primary: Closable,
    private readonly makeFallback: () => Closable,
    private readonly idleMs = FALLBACK_IDLE_S * 1000,
  ) {}

  health() {
    const primary = this.primary.health();
    const fb = this.fallback?.health() ?? { state: "idle" as const };
    // An idle fallback can serve on demand once the primary is down.
    const state: Health["state"] =
      primary.state === "ok" || fb.state === "ok" ? "ok" : primary.state === "down" ? (fb.state === "idle" ? "ok" : fb.state) : primary.state;
    return { state, primary, fallback: { ...fb, queries: this.fallbackQueries, warmups: this.warmups }, served: { ...this.served } };
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SerpRecord> {
    const p = this.primary.health();
    if (p.state === "down" && Number(p.retry_in) > 0) return this.viaFallback(params, signal, `cloudflare down: ${p.reason}`);
    const record = await this.primary.search(params, signal);
    if (signal?.aborted || !refused(record)) {
      if (record.search_metadata.status === "Success") {
        this.served.cloudflare++;
        if (this.onFallback) console.error("cloudflare serving again");
        this.onFallback = false;
      }
      return tag(record, "cloudflare");
    }
    return this.viaFallback(params, signal, `cloudflare refused: ${record.error}`);
  }

  private async viaFallback(params: SearchParams, signal: AbortSignal | undefined, why: string): Promise<SerpRecord> {
    if (!this.onFallback) console.error(`switching to the fallback proxy (${why})`);
    this.onFallback = true;
    clearTimeout(this.idleTimer);
    if (!this.fallback) {
      this.warmups++;
      this.fallback = this.makeFallback();
    }
    const fallback = this.fallback;
    this.inFlight++;
    this.fallbackQueries++;
    try {
      const record = await fallback.search(params, signal);
      if (record.search_metadata.status === "Success") this.served.fallback++;
      return tag(record, "fallback");
    } finally {
      if (--this.inFlight === 0) this.armIdle();
    }
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const fallback = this.fallback;
      if (!fallback || this.inFlight) return;
      this.fallback = null;
      console.error(`fallback idle for ${Math.round(this.idleMs / 1000)}s: closing its browsers`);
      fallback.close().catch((err) => console.error(`closing fallback: ${redact(err instanceof Error ? err.message : String(err))}`));
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    const fallback = this.fallback;
    this.fallback = null;
    await Promise.allSettled([this.primary.close(), fallback?.close()]);
  }
}

function tag(r: SerpRecord, egress: "cloudflare" | "fallback"): SerpRecord {
  r.search_metadata.egress = egress;
  return r;
}
