// The scraping core: a pool of warmed identities, exit rotation and a breaker.
// Ported from serpmaven's scraper.py `_query`, Breaker and output.py `build_record` (MIT).

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { poisoned } from "../classify/index.js";
import { type Parsed, parseSerp } from "../parse/index.js";
import type { SearchParams, Searcher, SerpRecord, Timings, Verdict, VerdictKind } from "../types.js";
import { GOOGLE } from "./browser.js";
import type { Answer } from "./hybrid.js";
import { DWELL_S, type Identity, openIdentity } from "./identity.js";
import { fillLinks, LINK_BUDGET_MS, linkBudgetMs, PARALLEL } from "./links.js";
import { ProxyTemplate, redact } from "./proxy.js";

export const MAX_EXITS = 3;
export const BREAKER = 6;
export const GAP_MS: [number, number] = [2_000, 5_000];
/** Browser results pages before the browser restarts on the same profile (serpmaven: 50); 0 never. */
export const BROWSER_MAX_PAGES = 50;
/** Queries before an identity drops its exit for a new session (serpmaven: 300); 0 never. */
export const EXIT_MAX_QUERIES = 300;
/** The pause after a browser restart before the identity searches again. */
export const SETTLE_MS: [number, number] = [5_000, 15_000];
/** Google looked at this exit and refused it: drop the exit. */
const REFUSED: VerdictKind[] = ["sorry", "wall", "block"];

export interface ScraperOptions {
  poolSize: number;
  makeIdentity: (signal: AbortSignal) => Promise<Identity>;
  origin?: string;
  gapMs?: [number, number];
  browserMaxPages?: number;
  exitMaxQueries?: number;
  settleMs?: [number, number];
  /** Link lookups in flight per page (`LINK_PARALLEL`). */
  linkParallel?: number;
  /** Link budget per page when the request gives no `links_wait` (`LINK_BUDGET_MS`). */
  linkBudgetMs?: number;
  /** Warm identities kept ready beyond the pool to replace a retired one at once (`SPARE_IDENTITIES`); 0 off. */
  spares?: number;
}

interface Slot {
  identity: Identity | null;
  busy: boolean;
  queries: number;
  lastPageAt: number;
  /** Whether each recent judged page was unrelated to its query (see classify `poisoned`). */
  lowRelevance: boolean[];
}

const message = (err: unknown) => redact(err instanceof Error ? err.message : String(err));
const seconds = (since: number) => ((performance.now() - since) / 1000).toFixed(1);

/** Stop waiting when `signal` aborts; `p` itself runs on. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const UULE_KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Google's `uule` for a canonical place name, e.g. "Austin,Texas,United States". */
export function uule(location: string): string {
  const raw = Buffer.from(location.trim(), "utf8");
  if (raw.length < 1 || raw.length >= UULE_KEY.length) throw new Error(`location must be 1 to ${UULE_KEY.length - 1} bytes long`);
  return `w+CAIQICI${UULE_KEY[raw.length]}${raw.toString("base64").replace(/=+$/, "")}`;
}

export function resultsUrl(origin: string, p: SearchParams): string {
  const u = new URL("/search", origin);
  u.searchParams.set("q", p.q);
  u.searchParams.set("hl", p.hl);
  for (const k of ["gl", "tbs", "cr", "lr"] as const) if (p[k]) u.searchParams.set(k, p[k]);
  if (p.page > 1) u.searchParams.set("start", String((p.page - 1) * 10));
  // Cloudflare exits sit anywhere, and Google places the local pack by the exit IP even with gl;
  // without a location, pin it to the gl country.
  const location = p.location || (p.gl ? countryName(p.gl) : undefined);
  // A uule keeps its "+" and base64 as browsers send it.
  return location ? `${u.href}&uule=${uule(location)}` : u.href;
}

const regions = new Intl.DisplayNames(["en"], { type: "region" });
/** English country name for a two-letter code ("us" → "United States"); undefined when unknown. */
export function countryName(gl: string): string | undefined {
  try {
    const name = regions.of(gl.toUpperCase());
    return name && name !== gl.toUpperCase() && name !== "Unknown Region" ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Raw timings while a page runs: milliseconds as measured, rounded once in the record. */
type Clock = Omit<Timings, "total">;

function finishTimings(t: Clock, started: number): Timings {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) if (v !== undefined) out[k] = typeof v === "number" ? Math.round(v) : v;
  if (!t.retries?.length) delete out.retries;
  return { ...out, total: Math.round(performance.now() - started) } as Timings;
}

function buildRecord(
  params: SearchParams,
  started: number,
  o: { url: string | null; verdict: Verdict | null; exit: Record<string, unknown>; parsed?: Parsed; error?: string; timings: Clock },
): SerpRecord {
  let parsed = {};
  if (o.parsed !== undefined && o.error === undefined) {
    const { goto_links: _, ping_paths: __, ...fields } = o.parsed; // these feed link resolution, not callers
    parsed = fields;
  }
  return {
    search_metadata: {
      id: randomUUID().replaceAll("-", ""),
      status: o.error === undefined && o.parsed !== undefined ? "Success" : "Error",
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      total_time_taken: Math.round((performance.now() - started) / 10) / 100,
      google_url: o.url,
      page_verdict: o.verdict?.kind ?? null,
      verdict_reason: o.verdict?.reason ?? null,
      timings: finishTimings(o.timings, started),
    },
    search_parameters: { ...params, engine: "google", device: "desktop" },
    ...parsed,
    exit: o.exit,
    ...(o.error !== undefined && { error: o.error }),
  };
}

/** With SAVE_HTML=<dir>, keep each fetched results page for inspecting Google's real markup. */
function saveHtml(dir: string | undefined, p: SearchParams, html: string): void {
  if (!dir) return;
  const slug = p.q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "q";
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}-p${p.page}.html`);
  mkdir(dir, { recursive: true, mode: 0o700 })
    .then(() => writeFile(file, html, { mode: 0o600 }))
    .catch((err) => console.error(`SAVE_HTML: ${message(err)}`));
}

export class Scraper implements Searcher {
  private readonly slots: Slot[];
  private readonly closing = new AbortController();
  private readonly warming = new Set<Promise<void>>();
  private readonly upkeeps = new Set<Promise<void>>();
  /** Warmed spares; one still warming is only in `warming` and never handed out. */
  private readonly spares: Identity[] = [];
  private sparesWarming = 0;
  private waiters = new Set<() => void>();
  private refusedInRow = 0;
  private downReason: string | null = null;
  private lastError = "";
  private readonly origin: string;
  private readonly gapMs: [number, number];

  constructor(private readonly opts: ScraperOptions) {
    this.origin = opts.origin ?? GOOGLE;
    this.gapMs = opts.gapMs ?? GAP_MS;
    this.slots = Array.from({ length: opts.poolSize }, () => ({ identity: null, busy: false, queries: 0, lastPageAt: 0, lowRelevance: [] }));
    for (const slot of this.slots) this.warm(slot);
    this.refillSpares();
  }

  health() {
    if (this.downReason) return { state: "down" as const, reason: this.downReason };
    const ready = this.slots.filter((s) => s.identity);
    const info = { pool: this.slots.length, ready: ready.length, spares: this.spares.length };
    if (!ready.length) return { state: "warming" as const, ...info };
    if (ready.every((s) => s.busy)) return { state: "busy" as const, ...info };
    return { state: "ok" as const, ...info };
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SerpRecord> {
    const started = performance.now();
    const url = resultsUrl(this.origin, params);
    let verdict: Verdict | null = null;
    let error = "";
    let exit: Record<string, unknown> = { session: null, proxy_host: null };
    const timings: Clock = { retries: [] };
    const add = (k: "queue" | "links", since: number) => void (timings[k] = (timings[k] ?? 0) + performance.now() - since);
    for (let i = 0; i < MAX_EXITS && !this.downReason; i++) {
      let slot: Slot;
      const queued = performance.now();
      try {
        slot = await this.acquire(signal);
      } catch (err) {
        if (this.downReason && !signal?.aborted) break;
        throw err;
      } finally {
        add("queue", queued);
      }
      timings.exits = i + 1;
      const identity = slot.identity!;
      exit = { session: identity.session, proxy_host: identity.proxyHost };
      // Links resolve inside the work, so the identity stays taken until its lookups are done too.
      const work = this.attempt(slot, identity, url, signal, timings).then(async (answer) => {
        saveHtml(process.env.SAVE_HTML, params, answer.fetched.html);
        if (answer.verdict.kind !== "serp") return { answer };
        const parsed = parseSerp(answer.fetched.html, params.hl);
        // Results for other queries: Google's answer to some automated traffic. Judged before lookups.
        if (poisoned(slot.lowRelevance, params.q, parsed.organic_results.map((r) => r.title))) return { answer, parsed, poisoned: true };
        if (identity.lookup && params.links !== 0 && params.links_wait !== 0) {
          // Lookups never throw and a refusal there does not touch the exit rotation.
          // links_wait sets the budget, so lookups still out then are aborted, not left holding the identity.
          const lookup = identity.lookup.bind(identity);
          const budgetMs = linkBudgetMs(params.links_wait, this.opts.linkBudgetMs ?? LINK_BUDGET_MS);
          const t0 = performance.now();
          const stats = await fillLinks(parsed.organic_results.slice(0, params.links), parsed.ping_paths, lookup, this.origin, signal, {
            budgetMs,
            parallel: this.opts.linkParallel ?? PARALLEL,
          });
          add("links", t0);
          timings.links_held = (timings.links_held ?? 0) + stats.heldMs;
          timings.links_lookups = (timings.links_lookups ?? 0) + stats.lookups;
        }
        return { answer, parsed, poisoned: false };
      });
      // The identity stays taken until its work really settles, even when the caller stopped waiting,
      // and, when it keeps its exit, until a browser restart is done too.
      let settled = false;
      const done = work.then(
        () => void (settled = true),
        () => void (settled = true),
      );
      let keep = false;
      try {
        let answer: Answer;
        let parsed: Parsed | undefined;
        let poison: boolean | undefined;
        try {
          ({ answer, parsed, poisoned: poison } = await abortable(work, signal));
        } catch (err) {
          if (signal?.aborted) throw err;
          // A browser crash or a network error: this exit is no use, but it is not Google's answer.
          [verdict, error] = [null, message(err)];
          timings.retries!.push("error");
          this.retire(slot, identity);
          continue;
        }
        if (poison) {
          [verdict, error] = [null, "results unrelated to the query"];
          timings.retries!.push("poisoned");
          this.retire(slot, identity);
          continue;
        }
        if (answer.verdict.kind === "serp") {
          this.refusedInRow = 0;
          keep = true;
          return buildRecord(params, started, { url: answer.fetched.url, verdict: answer.verdict, exit, parsed, timings });
        }
        if (!REFUSED.includes(answer.verdict.kind)) {
          // Not a refusal (unknown, consent, no_js, empty): keep the exit and say what was seen.
          keep = true;
          return buildRecord(params, started, { url: answer.fetched.url, verdict: answer.verdict, exit, error: `page not served: ${answer.verdict.reason}`, timings });
        }
        [verdict, error] = [answer.verdict, ""];
        timings.retries!.push(answer.verdict.kind);
        this.retire(slot, identity);
      } finally {
        const restart = settled && keep ? this.upkeep(slot, identity) : undefined;
        if (!settled) done.then(() => this.release(slot));
        else if (!restart) this.release(slot);
        else {
          const job = restart.finally(() => {
            this.upkeeps.delete(job);
            this.release(slot);
          });
          this.upkeeps.add(job);
        }
      }
    }
    if (this.downReason && !verdict && !error) error = `scraper is down: ${this.downReason}`;
    return buildRecord(params, started, {
      url: null,
      verdict,
      exit,
      error: error || `refused on ${MAX_EXITS} exits: ${verdict?.reason ?? "unknown"}`,
      timings,
    });
  }

  /** Close every browser and remove its profile. Warm-ups in flight stop at their next step. */
  async close(): Promise<void> {
    this.closing.abort(new Error("scraper closed"));
    this.notify();
    await Promise.allSettled([...this.warming, ...this.upkeeps]);
    await Promise.allSettled([...this.slots.map((s) => s.identity?.close()), ...this.spares.splice(0).map((i) => i.close())]);
    for (const s of this.slots) s.identity = null;
  }

  private async attempt(slot: Slot, identity: Identity, url: string, signal: AbortSignal | undefined, ms: Clock): Promise<Answer> {
    if (slot.queries) {
      // The gap is time since the last page, not a wait added to it.
      const [lo, hi] = this.gapMs;
      const rest = lo + Math.random() * (hi - lo) - (performance.now() - slot.lastPageAt);
      if (rest > 0) await sleep(rest, undefined, { signal });
    }
    try {
      return await identity.fetch(url, signal, ms);
    } finally {
      slot.queries++;
      slot.lastPageAt = performance.now();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<Slot> {
    for (;;) {
      signal?.throwIfAborted();
      this.closing.signal.throwIfAborted();
      if (this.downReason) throw new Error(`scraper is down: ${this.downReason}`);
      const slot = this.slots.find((s) => s.identity && !s.busy);
      if (slot) {
        slot.busy = true;
        return slot;
      }
      let wake!: () => void;
      await abortable(new Promise<void>((r) => this.waiters.add((wake = r))), signal).finally(() => this.waiters.delete(wake));
    }
  }

  private release(slot: Slot): void {
    slot.busy = false;
    this.notify();
  }

  private notify(): void {
    const ws = this.waiters;
    this.waiters = new Set();
    for (const w of ws) w();
  }

  /**
   * Drop an identity; a warmed spare takes its slot at once, else a new one warms there.
   * `failed` counts it towards the breaker, `why` is logged once the new one is ready.
   */
  private retire(slot: Slot, identity: Identity, failed = true, why?: string): void {
    if (slot.identity === identity) slot.identity = null;
    identity.close().catch((err) => console.error(`closing identity ${identity.session}: ${message(err)}`));
    if (failed) this.failed();
    const spare = this.downReason || this.closing.signal.aborted ? undefined : this.spares.shift();
    if (spare) {
      Object.assign(slot, { identity: spare, queries: 0, lastPageAt: 0, lowRelevance: [] });
      if (why) console.error(`${why}: spare identity ${spare.session} took its place`);
      this.notify();
    } else this.warm(slot, why);
    this.refillSpares();
  }

  /**
   * Warm spares up to `spares`. They take no queries and a failed warm-up does not count towards
   * the breaker; it is retried at the next retire, not in a loop.
   */
  private refillSpares(): void {
    while (this.spares.length + this.sparesWarming < (this.opts.spares ?? 0) && !this.downReason && !this.closing.signal.aborted) {
      this.sparesWarming++;
      const job = (async () => {
        try {
          const identity = await this.opts.makeIdentity(this.closing.signal);
          if (this.closing.signal.aborted || this.downReason) return void (await identity.close());
          this.spares.push(identity);
        } catch (err) {
          if (!this.closing.signal.aborted) console.error(`spare warm-up failed: ${message(err)}`);
        }
      })().finally(() => {
        this.sparesWarming--;
        this.warming.delete(job);
      });
      this.warming.add(job);
    }
  }

  /**
   * Between queries, on an identity that kept its exit: the per-exit query cap, then the browser
   * restart. Returns the restart when one runs, so the slot stays taken until it is over.
   */
  private upkeep(slot: Slot, identity: Identity): Promise<void> | undefined {
    if (slot.identity !== identity || this.closing.signal.aborted) return;
    const maxQueries = this.opts.exitMaxQueries ?? EXIT_MAX_QUERIES;
    if (maxQueries && slot.queries >= maxQueries) {
      return void this.retire(slot, identity, false, `identity ${identity.session} retired after ${slot.queries} queries (EXIT_MAX_QUERIES)`);
    }
    const maxPages = this.opts.browserMaxPages ?? BROWSER_MAX_PAGES;
    const pages = identity.browserPages ?? 0;
    if (!maxPages || !identity.restart || pages < maxPages) return;
    return this.restart(slot, identity, identity.restart.bind(identity), pages);
  }

  private async restart(slot: Slot, identity: Identity, restart: () => Promise<void>, pages: number): Promise<void> {
    try {
      const t0 = performance.now();
      await restart();
      const [lo, hi] = this.opts.settleMs ?? SETTLE_MS;
      const settle = lo + Math.random() * (hi - lo);
      console.error(`browser restart on ${identity.session} after ${pages} pages (BROWSER_MAX_PAGES): ${seconds(t0)}s, settling ${(settle / 1000).toFixed(1)}s`);
      await sleep(settle, undefined, { signal: this.closing.signal });
    } catch (err) {
      if (this.closing.signal.aborted) return;
      this.lastError = message(err);
      console.error(`browser restart failed: ${this.lastError}`);
      this.retire(slot, identity);
    }
  }

  /** Exits refused or unreachable in a row; a served page anywhere resets the count. */
  private failed(): void {
    if (++this.refusedInRow >= BREAKER && !this.downReason) {
      this.downReason = `${this.refusedInRow} exits in a row were refused or unreachable${this.lastError ? ` (last: ${this.lastError})` : ""}; check the proxy and restart`;
      console.error(`scraper down: ${this.downReason}`);
      this.notify();
    }
  }

  private warm(slot: Slot, why?: string): void {
    const t0 = performance.now();
    const job = (async () => {
      while (!this.downReason && !this.closing.signal.aborted) {
        try {
          const identity = await this.opts.makeIdentity(this.closing.signal);
          if (this.closing.signal.aborted) return void (await identity.close());
          Object.assign(slot, { identity, queries: 0, lastPageAt: 0, lowRelevance: [] });
          if (why) console.error(`${why}: new identity ${identity.session} ready in ${seconds(t0)}s`);
          return;
        } catch (err) {
          if (this.closing.signal.aborted) return;
          this.lastError = message(err);
          console.error(`warm-up failed: ${this.lastError}`);
          this.failed();
        }
      }
    })().finally(() => {
      this.warming.delete(job);
      this.notify();
    });
    this.warming.add(job);
  }
}

const scraperEnv = z.object({
  SCRAPER_PROXY: z.string().min(1),
  POOL_SIZE: z.coerce.number().int().min(1).default(1),
  WARMUP_DWELL_S: z.coerce.number().min(0).default(DWELL_S),
  BROWSER_MAX_PAGES: z.coerce.number().int().min(0).default(BROWSER_MAX_PAGES),
  EXIT_MAX_QUERIES: z.coerce.number().int().min(0).default(EXIT_MAX_QUERIES),
  LINK_PARALLEL: z.coerce.number().int().min(1).default(PARALLEL),
  LINK_BUDGET_MS: z.coerce.number().int().min(1).default(LINK_BUDGET_MS),
  SPARE_IDENTITIES: z.coerce.number().int().min(0).default(1),
});

/** The real scraper from the environment; throws with a readable message on a bad setting. */
export function createScraper(env: NodeJS.ProcessEnv = process.env): { scraper: Scraper; describe: string } {
  const parsed = scraperEnv.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const cfg = parsed.data;
  const proxy = new ProxyTemplate(cfg.SCRAPER_PROXY);
  const scraper = new Scraper({
    poolSize: cfg.POOL_SIZE,
    browserMaxPages: cfg.BROWSER_MAX_PAGES,
    exitMaxQueries: cfg.EXIT_MAX_QUERIES,
    linkParallel: cfg.LINK_PARALLEL,
    linkBudgetMs: cfg.LINK_BUDGET_MS,
    spares: cfg.SPARE_IDENTITIES,
    makeIdentity: (signal) => openIdentity(proxy, { dwellS: cfg.WARMUP_DWELL_S }, signal),
  });
  return { scraper, describe: `proxy ${proxy.describe()}, pool ${cfg.POOL_SIZE}, spares ${cfg.SPARE_IDENTITIES}` };
}
