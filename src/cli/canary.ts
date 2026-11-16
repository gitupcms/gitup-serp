#!/usr/bin/env tsx
// `npm run canary`: a few live queries that tell whether Google's markup still parses.
// Exit 0 all checks pass, 1 any fails, 2 no egress configured (or bad arguments).

import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Runtime } from "../bootstrap.js";
import type { SearchParams, SerpRecord } from "../types.js";

export type Kind = "commercial" | "local" | "tech" | "locale";

export interface CanaryQuery {
  kind: Kind;
  params: SearchParams;
}

// links: 0, the canary checks parsing, not link resolution.
const p = (q: string, hl: string, gl: string): SearchParams => ({ q, page: 1, hl, gl, links: 0 });
export const QUERIES: CanaryQuery[] = [
  { kind: "commercial", params: p("car insurance quote", "en", "us") },
  { kind: "commercial", params: p("best credit card", "en", "us") },
  { kind: "local", params: p("pizza near me", "en", "us") },
  { kind: "tech", params: p("hono framework", "en", "us") },
  { kind: "locale", params: p("en iyi kahve makinesi", "tr", "tr") },
  { kind: "locale", params: p("東京 観光 おすすめ", "ja", "jp") },
];

export const MIN_ORGANIC = 5;

export interface Check {
  ok: boolean;
  text: string;
  /** Index into the results of the query it is about; group checks have none. */
  query?: number;
  /** Shown, never fails the run. */
  info?: boolean;
}

const count = (r: SerpRecord, field: string) => (Array.isArray(r[field]) ? (r[field] as unknown[]).length : 0);

/**
 * Per query: verdict serp and at least MIN_ORGANIC organic results; local results on the local
 * query. Ads and AI Overview come and go, so ads must show on at least one commercial query, and
 * AI Overview on the tech query is reported but never fails the run.
 */
export function evaluate(queries: CanaryQuery[], records: SerpRecord[]): Check[] {
  const checks: Check[] = [];
  queries.forEach(({ kind, params }, i) => {
    const r = records[i]!;
    const name = JSON.stringify(params.q);
    const verdict = r.search_metadata.page_verdict;
    const reason = r.error ?? r.search_metadata.verdict_reason;
    checks.push({ ok: verdict === "serp", text: `${name}: verdict ${verdict ?? "none"}${verdict !== "serp" && reason ? ` (${reason})` : ""}`, query: i });
    const organic = count(r, "organic_results");
    checks.push({ ok: organic >= MIN_ORGANIC, text: `${name}: ${organic} organic (${MIN_ORGANIC} or more)`, query: i });
    if (kind === "local") {
      const local = count(r, "local_results");
      checks.push({ ok: local > 0, text: `${name}: ${local} local results (1 or more)`, query: i });
    }
    if (kind === "tech") {
      const text = (r.ai_overview as { text?: string } | undefined)?.text;
      checks.push({ ok: Boolean(text), text: `${name}: AI Overview ${text ? "present" : "absent"} (info only)`, query: i, info: true });
    }
  });
  const commercial = queries.flatMap((q, i) => (q.kind === "commercial" ? [i] : []));
  if (commercial.length) {
    const withAds = commercial.filter((i) => count(records[i]!, "ads") > 0);
    checks.push({ ok: withAds.length > 0, text: `ads on ${withAds.length} of ${commercial.length} commercial queries (1 or more)` });
  }
  return checks;
}

/** Queries to save: those with a failing check of their own, or every commercial one when the ads check fails. */
export function failingQueries(queries: CanaryQuery[], checks: Check[]): number[] {
  const bad = new Set<number>();
  for (const c of checks) {
    if (c.ok || c.info) continue;
    if (c.query !== undefined) bad.add(c.query);
    else queries.forEach((q, i) => q.kind === "commercial" && bad.add(i));
  }
  return [...bad].sort((a, b) => a - b);
}

export interface Deps {
  startRuntime: () => Promise<Runtime>;
  env: NodeJS.ProcessEnv;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export async function runCanary(argv: string[], deps: Deps, queries = QUERIES): Promise<number> {
  let save: string | undefined;
  try {
    save = parseArgs({ args: argv, options: { save: { type: "string" } } }).values.save;
  } catch (err) {
    deps.stderr(`error: ${(err as Error).message}\nusage: npm run canary [-- --save DIR]\n`);
    return 2;
  }

  const runtime = await deps.startRuntime();
  if (!runtime.live) {
    await runtime.close();
    deps.stderr("canary: no egress configured (npm run egress:up or set SCRAPER_PROXY)\n");
    return 2;
  }

  // The scraper writes each fetched page under SAVE_HTML at call time; one dir per query keeps them apart.
  const tmp = save ? mkdtempSync(join(tmpdir(), "canary-")) : undefined;
  const records: SerpRecord[] = [];
  try {
    for (const [i, { params }] of queries.entries()) {
      if (tmp) deps.env.SAVE_HTML = join(tmp, String(i));
      const start = performance.now();
      try {
        records.push(await runtime.searcher.search(params));
      } catch (err) {
        records.push(errorRecord(params, err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
      }
      deps.stderr(`${JSON.stringify(params.q)}: ${((performance.now() - start) / 1000).toFixed(1)}s\n`);
    }
  } finally {
    if (tmp) delete deps.env.SAVE_HTML;
    await runtime.close();
  }

  const checks = evaluate(queries, records);
  for (const c of checks) deps.stdout(`${c.ok ? "✓" : c.info ? "-" : "✗"} ${c.text}\n`);
  const failed = failingQueries(queries, checks);

  if (tmp && save) {
    for (const i of failed) {
      let files: string[] = [];
      try {
        files = readdirSync(join(tmp, String(i)));
      } catch {}
      if (!files.length) {
        deps.stderr(`no page saved for ${JSON.stringify(queries[i]!.params.q)} (it failed before a page came back)\n`);
        continue;
      }
      mkdirSync(save, { recursive: true });
      for (const f of files) cpSync(join(tmp, String(i), f), join(save, `${i}-${f}`));
    }
    if (failed.length) deps.stderr(`failing pages saved to ${save}\n`);
    rmSync(tmp, { recursive: true, force: true });
  }
  return failed.length ? 1 : 0;
}

function errorRecord(params: SearchParams, error: string): SerpRecord {
  return {
    search_metadata: {
      id: "",
      status: "Error",
      created_at: new Date().toISOString(),
      total_time_taken: 0,
      google_url: null,
      page_verdict: null,
      verdict_reason: null,
    },
    search_parameters: { ...params, engine: "google", device: "desktop" },
    error,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await runCanary(process.argv.slice(2), {
    startRuntime: async () => (await import("../bootstrap.js")).startRuntime(),
    env: process.env,
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
  });
}
