// Short-lived cache of successful result pages, in front of any Searcher (API, MCP and CLI alike).
import { randomUUID } from "node:crypto";
import type { SearchParams, Searcher, SerpRecord } from "../types.js";

/** The parameters that make two searches different; empty strings count as unset, as in resultsUrl. */
export function cacheKey(p: SearchParams): string {
  return JSON.stringify([
    p.q.trim(),
    p.page,
    p.hl,
    p.gl || null,
    p.location || null,
    p.tbs || null,
    p.cr || null,
    p.lr || null,
    p.links ?? null,
    p.links_wait ?? null,
  ]);
}

/** A deep copy under a new id and creation time, so callers never share or overwrite a stored record. */
function copy(r: SerpRecord, cached: boolean): SerpRecord {
  const c = structuredClone(r);
  c.search_metadata.id = randomUUID().replaceAll("-", "");
  c.search_metadata.created_at = new Date().toISOString();
  if (cached) c.search_metadata.cached = true;
  return c;
}

/** Rejects when `signal` aborts, so a caller sharing someone else's search can still give up. */
function until<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  signal.throwIfAborted();
  return Promise.race([
    p,
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  ]);
}

export class CachingSearcher implements Searcher {
  private items = new Map<string, { record: SerpRecord; expires: number }>();
  private inflight = new Map<string, Promise<SerpRecord>>();

  constructor(
    private readonly inner: Searcher & { close?(): Promise<void> },
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}

  get size(): number {
    return this.items.size;
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SerpRecord> {
    const key = cacheKey(params);
    const hit = this.items.get(key);
    if (hit && hit.expires > Date.now()) return copy(hit.record, true);
    if (hit) this.items.delete(key);

    const shared = this.inflight.get(key);
    if (shared) return copy(await until(shared, signal), false);
    // shortcut: the shared search runs under the first caller's signal; if that caller aborts, the others get its error.
    const run = this.inner.search(params, signal).then((r) => {
      if (r.search_metadata.status === "Success") this.store(key, r);
      return r;
    });
    this.inflight.set(key, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(key);
    }
  }

  private store(key: string, record: SerpRecord): void {
    this.items.delete(key);
    this.items.set(key, { record: structuredClone(record), expires: Date.now() + this.ttlMs });
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value!);
  }

  health() {
    return { ...this.inner.health(), cache: { size: this.items.size } };
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }
}
