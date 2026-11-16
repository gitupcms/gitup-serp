// One identity = one browser profile + one proxy session + its cookies.
// Warm-up ported from serpmaven's warmup.py and scraper.py `_warm` (MIT).

import { Browser, GOOGLE } from "./browser.js";
import { type Answer, CurlHttp, Hybrid, type PhaseMs } from "./hybrid.js";
import type { LinkAnswer } from "./links.js";
import { newSessionId, type ProxyTemplate } from "./proxy.js";

/** serpmaven's "light" ladder: normal sites first, then Google properties. No clicks, no typing. */
export const LADDER = [
  "https://www.theverge.com/",
  "https://www.wikihow.com/Main-Page",
  "https://translate.google.com/?hl=en",
  "https://scholar.google.com/?hl=en",
];
/**
 * Upper bound of the seconds spent on each warm-up page; each dwell is drawn from [half, all].
 * serpmaven measured 20-45 s as better for a first search, but here the first API request waits
 * for the warm-up inside REQUEST_TIMEOUT_MS (120 s by default): four pages at 45 s would not fit.
 */
export const DWELL_S = 10;

/** What the scraper needs from an identity; small so tests can fake it. */
export interface Identity {
  readonly session: string;
  readonly proxyHost: string | null;
  /** `ms` gets the HTTP and browser milliseconds (see `Hybrid.fetch`). */
  fetch(url: string, signal?: AbortSignal, ms?: PhaseMs): Promise<Answer>;
  /** A result-link lookup on the same HTTP client; without it links are left unresolved. */
  lookup?(url: string, signal?: AbortSignal): Promise<LinkAnswer>;
  close(): Promise<void>;
  /** Results pages the browser loaded since it (re)started; with `restart`, BROWSER_MAX_PAGES applies. */
  readonly browserPages?: number;
  /** Reopen the browser on the same profile, exit and cookies. */
  restart?(): Promise<void>;
}

export interface IdentityOptions {
  dwellS?: number;
  ladder?: string[];
  origin?: string;
}

/** Launch a browser on a new proxy session, warm it up and open Google. Aborts between pages. */
export async function openIdentity(proxy: ProxyTemplate | null, opts: IdentityOptions = {}, signal?: AbortSignal): Promise<Identity> {
  const { dwellS = DWELL_S, ladder = LADDER, origin = GOOGLE } = opts;
  const session = newSessionId();
  const endpoint = proxy?.forSession(session) ?? null;
  const browser = await Browser.open(endpoint, origin);
  try {
    for (const url of ladder) {
      signal?.throwIfAborted();
      await browser.visit(url, (dwellS * 1000 * (1 + Math.random())) / 2, signal);
    }
    signal?.throwIfAborted();
    // The proxy is down, the credentials are wrong or the exit is dead.
    if (!(await browser.home()) || !browser.headers) throw new Error("exit unreachable: google.com did not load");
    const hybrid = new Hybrid(browser, new CurlHttp(endpoint));
    return {
      session,
      proxyHost: endpoint?.host ?? null,
      fetch: (url, s, ms) => hybrid.fetch(url, s, ms),
      lookup: (url, s) => hybrid.lookup(url, s),
      close: () => browser.close(),
      get browserPages() {
        return browser.pages;
      },
      restart: () => browser.restart(),
    };
  } catch (err) {
    await browser.close();
    throw err;
  }
}
