// Writers for CLI output and `answered()` for --resume. Ported from serpmaven's output.py (MIT).

import { readFileSync, truncateSync } from "node:fs";
import type { SerpRecord } from "../types.js";

/** Where a writer puts text: process.stdout.write or a synchronous file write. */
export type Sink = (text: string) => void;

export interface Writer {
  write(record: SerpRecord): void;
  close(): void;
}

export const ORGANIC_COLUMNS = [
  "query",
  "page",
  "position",
  "title",
  "link",
  "displayed_link",
  "source",
  "date",
  "snippet",
] as const;

export const FORMATS = ["jsonl", "json", "csv"] as const;
export type Format = (typeof FORMATS)[number];

/** One record per line, written as it arrives, so a killed run keeps what it already paid for. */
function jsonl(sink: Sink): Writer {
  return { write: (r) => sink(`${JSON.stringify(r)}\n`), close: () => {} };
}

/** A single JSON array, written when the run ends. */
function json(sink: Sink): Writer {
  const records: SerpRecord[] = [];
  return { write: (r) => void records.push(r), close: () => sink(`${JSON.stringify(records, null, 2)}\n`) };
}

const cell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const row = (values: unknown[]) => `${values.map(cell).join(",")}\r\n`;

/** Organic results only, one row each. Failed pages write no rows; use jsonl when failures matter. */
function csv(sink: Sink): Writer {
  sink(row([...ORGANIC_COLUMNS]));
  return {
    write(r) {
      const results = Array.isArray(r.organic_results) ? (r.organic_results as Record<string, unknown>[]) : [];
      for (const res of results) {
        const fields: Record<string, unknown> = { ...res, query: r.search_parameters.q, page: r.search_parameters.page };
        sink(row(ORGANIC_COLUMNS.map((c) => fields[c])));
      }
    },
    close: () => {},
  };
}

export function openWriter(format: Format, sink: Sink): Writer {
  return { jsonl, json, csv }[format](sink);
}

/** The search_parameters that make two records answers to different searches. */
export const SAME_SEARCH = ["hl", "gl", "location", "tbs", "pws", "nfpr", "cr", "lr"] as const;

/**
 * The queries a JSON Lines file already holds every page for, for a run resuming into it with
 * `pages` pages per query and the search parameters in `params` (records made with others do not
 * count). Each query counts by its latest attempt (a page-1 record starts one): complete when every
 * page so far succeeded and the last is page `pages` or has no next page. A last line cut off by a
 * killed run is removed from the file, so records appended after it stay one per line.
 */
export function answered(path: string, pages = 1, params?: Record<string, unknown>): Set<string> {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw err;
  }
  // query -> [every page so far succeeded, last page, Google has another page]
  const state = new Map<string, [boolean, number, boolean]>();
  let end = 0;
  for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, end)) {
    const line = data.subarray(end, nl).toString("utf8");
    end = nl + 1;
    let query: string, page: unknown, ok: boolean, more: boolean;
    try {
      const record = JSON.parse(line);
      const asked = record.search_parameters;
      if (params && SAME_SEARCH.some((k) => asked[k] !== params[k])) continue;
      query = asked.q.trim();
      page = asked.page ?? 1;
      ok = record.search_metadata.status === "Success";
      more = Boolean(record.pagination?.next);
    } catch {
      continue;
    }
    if (!Number.isInteger(page) || (page as number) < 1) continue; // not a page number this program writes
    const before = page === 1 ? true : (state.get(query)?.[0] ?? false);
    state.set(query, [before && ok, page as number, more]);
  }
  if (end !== data.length) truncateSync(path, end);
  return new Set([...state].filter(([, [ok, last, more]]) => ok && (last >= pages || !more)).map(([q]) => q));
}
