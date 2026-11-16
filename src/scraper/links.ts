// Result destinations behind Google's `/goto?url=<token>`. Ported from serpmaven's links.py (MIT).
//
// Each result anchor carries a ping URL (`/url?...`) that Google answers with a small page naming
// the destination in a refresh tag. The `/goto` itself answers with the destination in `Location`.
// Google answers only a few links of a page at once; the rest get a "Verifying your request" page
// that reloads the same `/goto` after a few seconds, and asked again then, it redirects.
//
// Every lookup goes through the identity's own HTTP client (same exit, cookies and headers).
// A failed lookup leaves `link: null`; nothing here throws or turns itself off for later pages.

import { setTimeout as sleep } from "node:timers/promises";
import { LINKS_WAIT_MAX_S } from "../config.js";
import type { OrganicResult } from "../parse/index.js";

/** Default lookups in flight at once for one page (`LINK_PARALLEL`). A held link waits without taking one. */
export const PARALLEL = 4;
/** Default milliseconds one page's lookups may take in all; what is still out then stays null (`LINK_BUDGET_MS`). */
export const LINK_BUDGET_MS = 30_000;
/** The longest "Verifying your request" delay worth waiting out, in seconds. */
export const HELD_WAIT_MAX_S = 30;
/** Times a held link is asked again before it is left empty. */
export const HELD_ROUNDS = 2;
/** Added to the held page's delay before asking again. */
const HELD_MARGIN_MS = 500;

/** Status, Location (empty unless a redirect) and body of one lookup, redirects not followed. */
export interface LinkAnswer {
  status: number;
  location: string;
  body: string;
}

export type Lookup = (url: string, signal: AbortSignal) => Promise<LinkAnswer>;

export interface FillOptions {
  budgetMs?: number;
  parallel?: number;
  /** Waits out a held page's delay; replaced in tests. */
  wait?: (ms: number, signal: AbortSignal) => Promise<unknown>;
}

const REFRESH = /<meta[^>]*content="0;url=([^"]+)"/;
const SCRIPT = /redirectUrl='([^']+)'/;
const HELD = /<meta[^>]*content="(\d+);url=(\/goto\?[^"]+)"/;
// google.com, google.de, google.co.uk, google.com.br, google.cat and their subdomains.
const GOOGLE_HOST = /^(?:.+\.)?google\.(?:com|cat|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2})$/;

function unescapeHtml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (e[0] !== "#") return named[e.toLowerCase()] ?? m;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** `url` if a result can lead there: absolute http(s) with a host, and not Google's own redirect. */
export function destination(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/\.$/, "");
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !host) return null;
  if ((u.pathname === "/goto" || u.pathname === "/url") && GOOGLE_HOST.test(host.toLowerCase())) return null;
  return url;
}

/** The destination named by Google's answer to a ping URL. */
export function pingDestination(body: string): string | null {
  const refresh = REFRESH.exec(body);
  if (refresh) return destination(unescapeHtml(refresh[1]!));
  const script = SCRIPT.exec(body);
  if (script) return destination(script[1]!.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
  return null;
}

/** The delay in seconds and the `/goto` path of the "Verifying your request" page, or null. */
export function heldRefresh(body: string): [delayS: number, path: string] | null {
  const m = body.includes("/goto?") ? HELD.exec(body) : null;
  return m ? [Number(m[1]), unescapeHtml(m[2]!)] : null;
}

/** Google refused the exit: a 429 or a redirect to its sorry or consent page. */
export function refused(a: LinkAnswer): boolean {
  if (a.status === 429 || a.location.includes("/sorry")) return true;
  try {
    return /^(sorry|consent)\./.test(new URL(a.location).host.toLowerCase());
  } catch {
    return false;
  }
}

function tokenOf(link: string): string | null {
  try {
    return new URL(link).searchParams.get("url") || null;
  } catch {
    return null;
  }
}

/** The page's link budget: a request's `links_wait` (seconds, up to the max) when given, even above `budgetMs`. */
export function linkBudgetMs(linksWaitS: number | undefined, budgetMs = LINK_BUDGET_MS): number {
  return linksWaitS === undefined ? budgetMs : Math.round(Math.min(linksWaitS, LINKS_WAIT_MAX_S) * 1000);
}

/** What one page's link resolution did: lookups sent and the milliseconds spent in held waits. */
export interface FillStats {
  lookups: number;
  heldMs: number;
}

/**
 * Fill `link` for each result that has none but a `/goto` redirect: its ping URL first (from
 * `pings`, token to path), then the `/goto` itself, waiting out a held page. At most `parallel`
 * lookups run at once, all within `budgetMs`; a held page's wait does not count against `parallel`
 * and must end before the budget does. When the budget runs out the lookups still out are aborted. A sorry answer stops this page's lookups; an error
 * leaves that one result null. Resolves when every lookup has settled, with its stats; never rejects.
 */
export async function fillLinks(
  results: OrganicResult[],
  pings: Record<string, string>,
  lookup: Lookup,
  origin: string,
  signal?: AbortSignal,
  opts: FillOptions = {},
): Promise<FillStats> {
  const { budgetMs = LINK_BUDGET_MS, parallel = PARALLEL, wait = (ms, s) => sleep(ms, undefined, { signal: s }) } = opts;
  const stats: FillStats = { lookups: 0, heldMs: 0 };
  const todo = results.filter((r) => r.link === null && r.redirect_link?.includes("/goto?"));
  if (!todo.length || signal?.aborted) return stats;
  const deadline = Date.now() + budgetMs;
  const timeout = AbortSignal.timeout(budgetMs);
  const page = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let stopped = false;

  // Slots are taken per lookup, not per result, so a link waiting out a held page frees its slot.
  let free = parallel;
  const queued: (() => void)[] = [];
  const release = () => {
    const next = queued.shift();
    if (next) next();
    else free++;
  };

  const ask = async (path: string): Promise<LinkAnswer | null> => {
    if (free > 0) free--;
    else await new Promise<void>((r) => queued.push(r));
    try {
      if (stopped || page.aborted) return null;
      stats.lookups++;
      const a = await lookup(new URL(path, origin).href, page);
      if (!refused(a)) return a;
      stopped = true; // Google is refusing this exit: no more lookups for this page
    } catch {
      // A network error or the budget ran out: this result stays null.
    } finally {
      release();
    }
    return null;
  };

  const one = async (r: OrganicResult): Promise<string | null> => {
    const u = new URL(r.redirect_link!);
    const goto = u.pathname + u.search;
    const token = tokenOf(r.redirect_link!);
    const ping = token ? pings[token] : undefined;
    let next: string | null = ping ?? goto;
    let held = 0;
    let gotoAsked = false;
    while (next) {
      const path: string = next;
      next = null;
      if (path === goto) gotoAsked = true;
      const a = await ask(path);
      if (!a) return null;
      if (a.status >= 300 && a.status < 400) {
        const d = destination(a.location);
        if (d) return d;
      } else if (a.status === 200) {
        const d = pingDestination(a.body);
        if (d) return d;
        const hold = heldRefresh(a.body);
        const askAt = hold ? Date.now() + hold[0] * 1000 + HELD_MARGIN_MS : 0;
        if (hold && hold[0] <= HELD_WAIT_MAX_S && held < HELD_ROUNDS && askAt < deadline) {
          held++;
          const t0 = performance.now();
          try {
            await wait(askAt - Date.now(), page);
          } finally {
            stats.heldMs += performance.now() - t0;
          }
          next = hold[1];
          gotoAsked = true; // the held page reloads this result's own /goto
          continue;
        }
      }
      if (!gotoAsked) next = goto;
    }
    return null;
  };

  await Promise.all(
    todo.map(async (r) => {
      const link = await one(r).catch(() => null);
      if (link) r.link = link;
    }),
  );
  return stats;
}
