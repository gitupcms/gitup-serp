// Page extraction as the API, MCP and CLI use it: a shared concurrency cap, and `extract=N` on a search.
import type { SerpRecord } from "../types.js";
import { type ExtractOptions, type Extracted, extractPage } from "./index.js";

export const MAX_EXTRACT = 5;
export const MAX_EXTRACT_URLS = 20;

/** Pages for URLs (duplicates dropped, first-seen order kept). */
export type ExtractFn = (urls: string[], signal?: AbortSignal) => Promise<Extracted[]>;

/** `extractPage` with at most `parallel` pages in flight across every call of the returned function. */
export function extractor(parallel = 3, opts: Omit<ExtractOptions, "signal"> = {}): ExtractFn {
  let active = 0;
  const waiting: (() => void)[] = [];
  const one = async (url: string, signal?: AbortSignal) => {
    // A finishing page hands its slot straight to the next waiter, so `active` never overshoots.
    if (active >= parallel) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await extractPage(url, { ...opts, signal });
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
  return (urls, signal) => Promise.all([...new Set(urls)].map((u) => one(u, signal)));
}

/** `links` for a search with `extract=N`: organic links must be resolved for the first N. Unset means all. */
export function linksFor(links: number | undefined, extract: number): number | undefined {
  return links !== undefined && links < extract ? extract : links;
}

/**
 * Extract the first `n` organic results with a link, across `records` in order, and put each page
 * under its result as `extracted: {markdown, title?, error?}`. Returns how many were attached.
 */
export async function attachExtracts(records: SerpRecord[], n: number, extract: ExtractFn, signal?: AbortSignal): Promise<number> {
  if (n <= 0) return 0;
  const targets: Record<string, unknown>[] = [];
  for (const r of records) {
    for (const o of Array.isArray(r.organic_results) ? (r.organic_results as Record<string, unknown>[]) : []) {
      if (targets.length < n && typeof o.link === "string" && o.link) targets.push(o);
    }
  }
  if (!targets.length) return 0;
  const pages = await extract(targets.map((o) => o.link as string), signal);
  const byUrl = new Map<string, Extracted>();
  // extract() dedupes, so map back by the order of first appearance.
  [...new Set(targets.map((o) => o.link as string))].forEach((u, i) => byUrl.set(u, pages[i]!));
  for (const o of targets) {
    const p = byUrl.get(o.link as string)!;
    o.extracted = { markdown: p.markdown, ...(p.title ? { title: p.title } : {}), ...(p.error ? { error: p.error } : {}) };
  }
  return targets.length;
}
