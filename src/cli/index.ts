#!/usr/bin/env tsx
// The command line: `search` (serpmaven's search path) and `doctor`. Records go to stdout or
// --output, everything else to stderr.

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Runtime } from "../bootstrap.js";
import { readEgressState, STATE_FILE } from "../egress/state.js";
import type { SearchParams, SerpRecord } from "../types.js";
import { answered, FORMATS, type Format, openWriter, type Sink } from "./output.js";

const ROOT = resolve(import.meta.dirname, "../..");

const USAGE = `usage:
  gitup-serp search [query...] [--input FILE] [--pages N] [--hl LANG] [--gl CC] [--location TEXT]
                    [--links N] [--format jsonl|json|csv] [--output FILE] [--resume]
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
  links?: number;
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

export function parseSearchArgs(args: string[]): SearchOptions {
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
        links: { type: "string" },
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
  if (v.resume && (!v.output || format !== "jsonl")) throw new UsageError("--resume needs --output FILE in the jsonl format");
  return {
    queries: parsed.positionals,
    input: v.input,
    pages: int("pages", v.pages, 1) ?? 1,
    hl: v.hl ?? "en",
    gl: v.gl,
    location: v.location,
    links: int("links", v.links, 0),
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

async function search(args: string[], deps: Deps): Promise<number> {
  const opts = parseSearchArgs(args);
  let queries = await readQueries(opts, deps);
  if (opts.resume) {
    const done = answered(opts.output!, opts.pages, { hl: opts.hl, gl: opts.gl, location: opts.location });
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

  const runQuery = async (q: string) => {
    for (let page = 1; page <= opts.pages && !ac.signal.aborted; page++) {
      const params: SearchParams = { q, page, hl: opts.hl, gl: opts.gl, location: opts.location, links: opts.links };
      const start = performance.now();
      let record: SerpRecord;
      try {
        record = await runtime.searcher.search(params, ac.signal);
      } catch (err) {
        if (ac.signal.aborted) return;
        record = errorRecord(params, err instanceof Error ? `${err.name}: ${err.message}` : String(err), 0);
      }
      const seconds = ((performance.now() - start) / 1000).toFixed(1);
      const organic = Array.isArray(record.organic_results) ? record.organic_results.length : 0;
      const status = record.search_metadata.status;
      writer.write(record);
      deps.stderr(`${JSON.stringify(q)} page ${page}: ${status}, ${organic} organic, ${seconds}s\n`);
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
  checks.push([existsSync(resolve(ROOT, "bin/curl-impersonate")), "curl-impersonate in bin/ (npm run setup)"]);
  let chromium = false;
  try {
    chromium = readdirSync(resolve(ROOT, ".browsers")).some((d) => d.startsWith("chromium-"));
  } catch {}
  checks.push([chromium, "Chromium in .browsers/ (npm run setup)"]);
  const display = deps.env.DISPLAY ? "DISPLAY" : deps.env.WAYLAND_DISPLAY ? "WAYLAND_DISPLAY" : undefined;
  checks.push([Boolean(display), display ? `display: ${display} is set` : "display: neither DISPLAY nor WAYLAND_DISPLAY is set (headful Chromium needs one, e.g. Xvfb)"]);
  // Same order as bootstrap: SCRAPER_PROXY wins over the state file.
  if (deps.env.SCRAPER_PROXY) checks.push([true, "egress: SCRAPER_PROXY is set"]);
  else {
    try {
      const state = readEgressState();
      checks.push(state
        ? [true, `egress: cloudflare, ${state.workers.length} workers in ${STATE_FILE}`]
        : [false, "egress: none (npm run egress:up or set SCRAPER_PROXY)"]);
    } catch (err) {
      checks.push([false, `egress: ${(err as Error).message}`]);
    }
  }
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
