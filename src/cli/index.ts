#!/usr/bin/env tsx
// The command line: `search` (serpmaven's search path), `extract` and `doctor`. Records go to stdout or
// --output, everything else to stderr.

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Runtime } from "../bootstrap.js";
import { dateSchema, dateTbs, extractParallel, glSchema, hlSchema, httpUrlSchema, linksWaitSchema, searchDefaults } from "../config.js";
import { attachExtracts, type ExtractFn, extractor, linksFor, MAX_EXTRACT } from "../extract/attach.js";
import { egressHttp } from "../extract/index.js";
import { renderPages } from "../render.js";
import { readEgressState, STATE_FILE } from "../egress/state.js";
import type { SearchParams, SerpRecord, Timings } from "../types.js";
import { answered, FORMATS, type Format, openWriter, type Sink } from "./output.js";

const ROOT = resolve(import.meta.dirname, "../..");

const USAGE = `usage:
  gitup-serp search [query...] [--input FILE] [--pages N] [--hl LANG] [--gl CC] [--location TEXT]
                    [--date h|d|w|m|y|YYYYMMDD..YYYYMMDD] [--links N] [--links-wait S] [--extract N]
                    [--format jsonl|json|csv|markdown] [--output FILE] [--resume]
  gitup-serp extract <url>... [--format markdown|json]
  gitup-serp doctor
queries come from the arguments, --input (one per line) or stdin`;

export interface Deps {
  startRuntime: () => Promise<Runtime>;
  env: NodeJS.ProcessEnv;
  stdout: Sink;
  stderr: Sink;
  /** Read only when it is not a TTY and no query was given otherwise. */
  stdin?: AsyncIterable<string | Buffer> & { isTTY?: boolean };
  /** Aborts the run as Ctrl-C does. main() hooks SIGINT to it when not given. */
  signal?: AbortSignal;
}

export class UsageError extends Error {}

export interface SearchOptions {
  queries: string[];
  input?: string;
  pages: number;
  hl: string;
  gl?: string;
  location?: string;
  /** Google's tbs, from --date. */
  tbs?: string;
  links?: number;
  links_wait?: number;
  /** Extract the first N organic results with a link (0-5). */
  extract: number;
  format: Format;
  output?: string;
  resume: boolean;
}

function int(name: string, raw: string | undefined, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be an integer of ${min} or more`);
  return n;
}

/** `--links-wait` under the API's rule and message. */
function linksWait(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const r = linksWaitSchema.safeParse(raw.trim() === "" ? NaN : Number(raw));
  if (!r.success) throw new UsageError(r.error.issues[0]!.message);
  return r.data;
}

/** `--hl`/`--gl` under the API's rules and messages, else the DEFAULT_HL/DEFAULT_GL env. */
function locale(hl: string | undefined, gl: string | undefined, env: NodeJS.ProcessEnv): { hl: string; gl?: string } {
  for (const [s, v] of [[hlSchema, hl], [glSchema, gl]] as const) {
    const r = v === undefined ? undefined : s.safeParse(v);
    if (r && !r.success) throw new UsageError(r.error.issues[0]!.message);
  }
  let d;
  try {
    d = searchDefaults(env);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  return { hl: hl ?? d.hl, gl: gl ?? d.gl };
}

export function parseSearchArgs(args: string[], env: NodeJS.ProcessEnv = {}): SearchOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        input: { type: "string" },
        pages: { type: "string" },
        hl: { type: "string" },
        gl: { type: "string" },
        location: { type: "string" },
        date: { type: "string" },
        links: { type: "string" },
        "links-wait": { type: "string" },
        extract: { type: "string" },
        format: { type: "string" },
        output: { type: "string" },
        resume: { type: "boolean" },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const v = parsed.values;
  const format = (v.format ?? "jsonl") as Format;
  if (!FORMATS.includes(format)) throw new UsageError(`--format must be one of ${FORMATS.join(", ")}`);
  const date = v.date === undefined ? undefined : dateSchema.safeParse(v.date);
  if (date && !date.success) throw new UsageError(date.error.issues[0]!.message);
  const extract = int("extract", v.extract, 0) ?? 0;
  if (extract > MAX_EXTRACT) throw new UsageError(`--extract must be between 0 and ${MAX_EXTRACT}`);
  if (v.resume && (!v.output || format !== "jsonl")) throw new UsageError("--resume needs --output FILE in the jsonl format");
  return {
    queries: parsed.positionals,
    input: v.input,
    pages: int("pages", v.pages, 1) ?? 1,
    ...locale(v.hl, v.gl, env),
    location: v.location,
    tbs: date ? dateTbs(date.data) : undefined,
    links: linksFor(int("links", v.links, 0), extract),
    links_wait: linksWait(v["links-wait"]),
    extract,
    format,
    output: v.output,
    resume: v.resume ?? false,
  };
}

async function readQueries(opts: SearchOptions, deps: Deps): Promise<string[]> {
  let queries = [...opts.queries];
  if (opts.input) {
    try {
      queries.push(...readFileSync(opts.input, "utf8").replace(/^﻿/, "").split(/\r?\n/));
    } catch {
      throw new UsageError(`cannot read the query file ${opts.input} (one query per line)`);
    }
  }
  if (!queries.length && deps.stdin && !deps.stdin.isTTY) {
    let text = "";
    for await (const chunk of deps.stdin) text += chunk.toString();
    queries = text.split(/\r?\n/);
  }
  queries = queries.map((q) => q.trim()).filter(Boolean);
  if (!queries.length) throw new UsageError("no queries given");
  return queries;
}

function errorRecord(params: SearchParams, error: string, seconds: number): SerpRecord {
  return {
    search_metadata: {
      id: randomUUID().replaceAll("-", ""),
      status: "Error",
      created_at: new Date().toISOString(),
      total_time_taken: seconds,
      google_url: null,
      page_verdict: null,
      verdict_reason: null,
    },
    search_parameters: { ...params, engine: "google", device: "desktop" },
    error,
  };
}

/** EXTRACT_PARALLEL pages at once through the runtime's egress; none without one. */
function makeExtract(runtime: Runtime, env: NodeJS.ProcessEnv): ExtractFn {
  let parallel;
  try {
    parallel = extractParallel(env);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  return extractor(parallel, { http: egressHttp(runtime.egressProxy, runtime.fetchVia) });
}

/** Pages as markdown (default) or JSON (one object, or an array for several URLs); exit 1 if any failed. */
async function extract(args: string[], deps: Deps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { format: { type: "string" } } });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const format = parsed.values.format ?? "markdown";
  if (format !== "markdown" && format !== "json") throw new UsageError("--format must be markdown or json");
  if (!parsed.positionals.length) throw new UsageError("no URL given");
  const urls = parsed.positionals.map((u) => {
    const r = httpUrlSchema.safeParse(u);
    if (!r.success) throw new UsageError(`${r.error.issues[0]!.message}: ${u}`);
    return r.data;
  });
  const runtime = await deps.startRuntime();
  let pages;
  try {
    pages = await makeExtract(runtime, deps.env)(urls, deps.signal);
  } finally {
    await runtime.close();
  }
  if (format === "json") deps.stdout(`${JSON.stringify(pages.length === 1 ? pages[0] : pages, null, 2)}\n`);
  else deps.stdout(renderPages(pages, "markdown"));
  for (const p of pages) if (p.error) deps.stderr(`${p.url}: ${p.error}\n`);
  return pages.some((p) => !p.markdown) ? 1 : 0;
}

/** The main phases in short, e.g. `queue 0.1s fetch 1.2s links 14.3s (held 9.0s, 18 lookups) exits 1`. */
export function phases(t: Timings): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const out: string[] = [];
  for (const k of ["queue", "pace", "fetch", "browser"] as const) if (t[k] !== undefined) out.push(`${k} ${s(t[k])}`);
  if (t.links !== undefined) out.push(`links ${s(t.links)} (held ${s(t.links_held ?? 0)}, ${t.links_lookups ?? 0} lookups)`);
  if (t.exits !== undefined) out.push(`exits ${t.exits}`);
  if (t.retries?.length) out.push(`retries ${t.retries.join(",")}`);
  return out.join(" ");
}

async function search(args: string[], deps: Deps): Promise<number> {
  const opts = parseSearchArgs(args, deps.env);
  let queries = await readQueries(opts, deps);
  if (opts.resume) {
    const done = answered(opts.output!, opts.pages, { hl: opts.hl, gl: opts.gl, location: opts.location, tbs: opts.tbs });
    const total = queries.length;
    queries = queries.filter((q) => !done.has(q));
    deps.stderr(`resume: ${total - queries.length} of ${total} queries already in ${opts.output}\n`);
    if (!queries.length) return 0;
  }

  const ac = new AbortController();
  const onSigint = () => {
    deps.stderr("interrupted: closing\n");
    ac.abort();
  };
  if (deps.signal) deps.signal.addEventListener("abort", onSigint, { once: true });
  else process.once("SIGINT", onSigint);

  // Synchronous writes: each record is on disk before the next page starts.
  const fd = opts.output ? openSync(opts.output, opts.resume ? "a" : "w") : undefined;
  const writer = openWriter(opts.format, fd === undefined ? deps.stdout : (s) => void writeSync(fd, s));
  const runtime = await deps.startRuntime();
  let failed = false;
  let extractPages: ExtractFn | undefined;

  /** The scraper's state when it is down but retries later (its breaker cooling down); else undefined. */
  const cooling = () => {
    const h = runtime.searcher.health();
    return h.state === "down" && typeof h.retry_in === "number" ? { reason: String(h.reason), retryIn: h.retry_in } : undefined;
  };
  /** Wait `ms`, or less when the run is aborted. */
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        ac.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      ac.signal.addEventListener("abort", done, { once: true });
    });

  const runQuery = async (q: string) => {
    let toExtract = opts.extract;
    for (let page = 1; page <= opts.pages && !ac.signal.aborted; page++) {
      const params: SearchParams = { q, page, hl: opts.hl, gl: opts.gl, location: opts.location, tbs: opts.tbs, links: opts.links, links_wait: opts.links_wait };
      let start = performance.now();
      let record: SerpRecord;
      // A long run outlives the breaker: wait out its cooldown, and ask again a page it refused unasked.
      for (let tries = 0; ; tries++) {
        const down = cooling();
        if (down && (down.retryIn > 0 || tries > 0)) {
          if (down.retryIn > 0) deps.stderr(`scraper down (${down.reason}): waiting ${down.retryIn}s\n`);
          await pause(Math.max(1, down.retryIn) * 1000);
          if (ac.signal.aborted) return;
          start = performance.now();
        }
        try {
          record = await runtime.searcher.search(params, ac.signal);
        } catch (err) {
          if (ac.signal.aborted) return;
          record = errorRecord(params, err instanceof Error ? `${err.name}: ${err.message}` : String(err), 0);
        }
        if (!(record.error?.startsWith("scraper is down") && cooling())) break;
      }
      if (toExtract > 0) {
        extractPages ??= makeExtract(runtime, deps.env);
        try {
          toExtract -= await attachExtracts([record], toExtract, extractPages, ac.signal);
        } catch {
          if (ac.signal.aborted) return;
        }
      }
      const seconds = ((performance.now() - start) / 1000).toFixed(1);
      const organic = Array.isArray(record.organic_results) ? record.organic_results.length : 0;
      const status = record.search_metadata.status;
      writer.write(record);
      const t = record.search_metadata.timings;
      deps.stderr(`${JSON.stringify(q)} page ${page}: ${status}, ${organic} organic, ${seconds}s${t ? ` (${phases(t)})` : ""}\n`);
      if (status !== "Success") {
        failed = true;
        return;
      }
      if (!(record.pagination as { next?: string } | undefined)?.next) return;
    }
  };

  try {
    // POOL_SIZE identities inside the scraper; as many queries in flight, each query's pages in order.
    const workers = Math.max(1, Number.parseInt(deps.env.POOL_SIZE ?? "1", 10) || 1);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(workers, queries.length) }, async () => {
        while (next < queries.length && !ac.signal.aborted) await runQuery(queries[next++]!);
      }),
    );
  } finally {
    writer.close();
    if (fd !== undefined) closeSync(fd);
    await runtime.close();
    if (deps.signal) deps.signal.removeEventListener("abort", onSigint);
    else process.off("SIGINT", onSigint);
  }
  if (ac.signal.aborted) return 130;
  return failed ? 1 : 0;
}

function doctor(deps: Deps): number {
  const checks: [boolean, string][] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push([major >= 22, `Node ${process.versions.node} (22 or newer)`]);
  checks.push([existsSync(resolve(ROOT, "bin/curl-impersonate")), "curl-impersonate in bin/ (npm run setup, or gitup-serp setup)"]);
  let chromium = false;
  try {
    chromium = readdirSync(resolve(ROOT, ".browsers")).some((d) => d.startsWith("chromium-"));
  } catch {}
  checks.push([chromium, "Chromium in .browsers/ (npm run setup, or gitup-serp setup)"]);
  const display = deps.env.DISPLAY ? "DISPLAY" : deps.env.WAYLAND_DISPLAY ? "WAYLAND_DISPLAY" : undefined;
  checks.push([Boolean(display), display ? `display: ${display} is set` : "display: neither DISPLAY nor WAYLAND_DISPLAY is set (headful Chromium needs one, e.g. Xvfb)"]);
  // Same order as bootstrap: SCRAPER_PROXY wins over the state file.
  if (deps.env.SCRAPER_PROXY) checks.push([true, "egress: SCRAPER_PROXY is set"]);
  else {
    try {
      const state = readEgressState();
      checks.push(state
        ? [true, `egress: cloudflare, ${state.workers.length} workers in ${STATE_FILE}`]
        : [false, "egress: none (npm run egress:up, gitup-serp egress up, or set SCRAPER_PROXY)"]);
    } catch (err) {
      checks.push([false, `egress: ${(err as Error).message}`]);
    }
  }
  // Optional, so it never fails the doctor.
  checks.push([true, `FALLBACK_PROXY ${deps.env.FALLBACK_PROXY ? "is set" : "is not set (optional)"}`]);
  checks.push([true, `ENGINE_FALLBACK ${deps.env.ENGINE_FALLBACK ? `is set (${deps.env.ENGINE_FALLBACK})` : "is not set (optional)"}`]);
  for (const name of ["CF_API_TOKEN", "CF_ACCOUNT_ID"]) {
    checks.push([Boolean(deps.env[name]), `${name} ${deps.env[name] ? "is set" : "is not set"}`]);
  }
  for (const [ok, text] of checks) deps.stdout(`${ok ? "✓" : "✗"} ${text}\n`);
  return checks.every(([ok]) => ok) ? 0 : 1;
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "search") return await search(rest, deps);
    if (command === "extract") return await extract(rest, deps);
    if (command === "doctor" && !rest.length) return doctor(deps);
    throw new UsageError(command ? `unknown command: ${argv.join(" ")}` : "no command given");
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    deps.stderr(`error: ${err.message}\n${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const deps: Deps = {
    startRuntime: async () => (await import("../bootstrap.js")).startRuntime(),
    env: process.env,
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
    stdin: process.stdin,
  };
  process.exitCode = await main(process.argv.slice(2), deps);
}
