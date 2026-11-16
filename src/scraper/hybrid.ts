// Results pages over HTTPS between the browser's checks. Ported from serpmaven's hybrid.py (MIT).
//
// A browser that Google serves has passed a JavaScript check, and the cookies it holds afterwards
// are what Google accepts. An HTTP client with Chrome's TLS fingerprint, sending the browser's own
// request headers and those cookies, is served the same page until Google asks for the check
// again. Then the browser runs that one query, and the HTTP side carries on with fresh cookies.

import { resolve } from "node:path";
import { runBinary } from "cuimp";
import { classify } from "../classify/index.js";
import type { Verdict } from "../types.js";
import type { LinkAnswer } from "./links.js";
import { type ProxyEndpoint, redact } from "./proxy.js";

/**
 * The TLS and HTTP/2 fingerprint curl-impersonate presents. The only Chrome version written down:
 * UA and sec-ch-ua are never hand-written, they are the browser's own captured headers, so the
 * cookies and the headers always come from the same Chrome. The spike measured curl_chrome152's
 * JA4 and Akamai H2 fingerprints identical to patchright's Chromium 156, so no version shows on
 * the wire except the browser's header.
 */
export const IMPERSONATE = "chrome152";
export const CURL_BIN = resolve(import.meta.dirname, "../../bin/curl-impersonate");
/** Consecutive non-serp HTTP pages after which an identity stays on the browser. */
export const HTTP_MISSES = 3;
const HTTP_TIMEOUT_S = 20;

export type Headers = [name: string, value: string][];

export interface Fetched {
  url: string;
  status: number | null;
  html: string;
}

/** What the hybrid needs from a browser (see browser.ts); small so tests can fake it. */
export interface BrowserSide {
  /** The browser's request headers for a top-level navigation, in order; null until captured. */
  readonly headers: Headers | null;
  search(url: string): Promise<Fetched>;
  /** The cookies the browser would send to Google search, as one header. */
  cookies(): Promise<string>;
  setCookies(header: string): Promise<void>;
}

export interface HttpSide {
  get(url: string, headers: Headers, signal?: AbortSignal, body?: string): Promise<Fetched & { setCookies: string[] }>;
}

/** Milliseconds a results page spent on each side, added to by `Hybrid.fetch`. */
export type PhaseMs = { fetch?: number; browser?: number };

export interface Answer {
  fetched: Fetched;
  verdict: Verdict;
  via: "http" | "browser";
}

/** The browser's headers in its order, with `cookie` in place of the one it sent. */
export function replayHeaders(headers: Headers, cookie: string): Headers {
  const out: Headers = headers.filter(([n]) => !n.startsWith(":")).map(([n, v]) => [n, n === "cookie" ? cookie : v]);
  if (cookie && !out.some(([n]) => n === "cookie")) out.push(["cookie", cookie]);
  return out.filter(([n, v]) => n !== "cookie" || v);
}

/** The replayed headers as for a click on the results page: same-origin, with Google's referer. */
export function clickHeaders(headers: Headers, referer: string): Headers {
  const out: Headers = [];
  for (const [n, v] of headers) {
    if (n === "referer") continue;
    out.push([n, n === "sec-fetch-site" ? "same-origin" : v]);
    if (n === "accept-language") out.push(["referer", referer]);
  }
  if (!out.some(([n]) => n === "sec-fetch-site")) out.push(["sec-fetch-site", "same-origin"]);
  if (!out.some(([n]) => n === "referer")) out.push(["referer", referer]);
  return out;
}

function expired(header: string): boolean {
  const low = header.toLowerCase();
  if (/max-age=(0|-\d)/.test(low)) return true;
  const m = /expires=([^;]+)/i.exec(header);
  if (!m) return false;
  const when = Date.parse(m[1]!.trim());
  return !Number.isNaN(when) && when <= Date.now();
}

/** Apply Set-Cookie headers to a cookie header, keeping the order; expired names are dropped. */
export function foldCookies(cookie: string, setCookies: string[]): string {
  const pairs = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) pairs.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const h of setCookies) {
    const first = h.split(";", 1)[0]!;
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    if (expired(h)) pairs.delete(name);
    else pairs.set(name, first.slice(i + 1).trim());
  }
  return [...pairs].map(([n, v]) => `${n}=${v}`).join("; ");
}

/** A curl config string: in double quotes, backslash and quote escaped, newlines refused. */
function quote(s: string): string {
  if (/[\r\n]/.test(s)) throw new Error("newline in a curl config value");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Split curl's `-i` output into the last response head and the body. */
export function parseCurlOutput(buf: Buffer, url: string): Fetched & { setCookies: string[] } {
  let rest = buf;
  for (;;) {
    const sep = rest.indexOf("\r\n\r\n");
    if (sep < 0) throw new Error("curl returned no HTTP response");
    const lines = rest.subarray(0, sep).toString("latin1").split("\r\n");
    rest = rest.subarray(sep + 4);
    const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
    if (status >= 100 && status < 200) continue; // an interim response; the real one follows
    const setCookies: string[] = [];
    let location = "";
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      const name = line.slice(0, i).trim().toLowerCase();
      const value = line.slice(i + 1).trim();
      if (name === "set-cookie") setCookies.push(value);
      else if (name === "location") location = value;
    }
    // Redirects are not followed: the final URL of a 3xx is where it points, so /sorry is seen.
    const finalUrl = location && status >= 300 && status < 400 ? new URL(location, url).href : url;
    return { url: finalUrl, status, html: rest.toString("utf8"), setCookies };
  }
}

/**
 * curl-impersonate through cuimp's process runner. Everything but `-K -` goes in a config on
 * stdin, so the proxy password and cookies never show in the process list.
 */
export class CurlHttp implements HttpSide {
  constructor(
    private readonly proxy: ProxyEndpoint | null,
    private readonly bin = CURL_BIN,
  ) {
    // Read by curl-impersonate at start. The `--impersonate` flag would also add its own header
    // set; through the environment with HEADERS=no it sends only ours, in our order.
    process.env.CURL_IMPERSONATE = IMPERSONATE;
    process.env.CURL_IMPERSONATE_HEADERS = "no";
  }

  /** With `body`, a form POST instead (DuckDuckGo's next page). */
  async get(url: string, headers: Headers, signal?: AbortSignal, body?: string) {
    const lines = ["silent", "show-error", "include", "compressed", "suppress-connect-headers"];
    lines.push(`max-time = ${HTTP_TIMEOUT_S}`, `url = ${quote(url)}`);
    if (body !== undefined) lines.push(`data-raw = ${quote(body)}`);
    for (const [n, v] of headers) lines.push(`header = ${quote(`${n}: ${v}`)}`);
    if (this.proxy) {
      lines.push(`proxy = ${quote(this.proxy.server)}`);
      if (this.proxy.username) lines.push(`proxy-user = ${quote(`${this.proxy.username}:${this.proxy.password ?? ""}`)}`);
    }
    const r = await runBinary(this.bin, ["-K", "-"], { signal, stdin: lines.join("\n") + "\n" });
    if (r.exitCode !== 0) throw new Error(`curl exit ${r.exitCode}: ${redact(r.stderr.toString("utf8").trim())}`);
    return parseCurlOutput(r.stdout, url);
  }
}

/** One identity's way to a results page: HTTP while Google serves it there, the browser otherwise. */
export class Hybrid {
  private cookie = "";
  private misses = 0;
  /** The HTTP side gave up on this identity; every page now comes from the browser. */
  browserOnly = false;

  constructor(
    private readonly browser: BrowserSide,
    private readonly http: HttpSide,
    private readonly maxMisses = HTTP_MISSES,
  ) {}

  /** `ms` gets the milliseconds spent on the HTTP try and the browser, added even when this throws. */
  async fetch(url: string, signal?: AbortSignal, ms: PhaseMs = {}): Promise<Answer> {
    const headers = this.browser.headers;
    if (!this.browserOnly && headers) {
      const t0 = performance.now();
      try {
        if (!this.cookie) this.cookie = await this.browser.cookies();
        const r = await this.http.get(url, replayHeaders(headers, this.cookie), signal);
        this.cookie = foldCookies(this.cookie, r.setCookies);
        const verdict = classify(r.html, r.url, r.status ?? undefined);
        if (verdict.kind === "serp") {
          this.misses = 0;
          return { fetched: { url: r.url, status: r.status, html: r.html }, verdict, via: "http" };
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        // Any other HTTP failure: the browser takes the query, as for a check page.
      } finally {
        ms.fetch = (ms.fetch ?? 0) + performance.now() - t0;
      }
      if (++this.misses >= this.maxMisses) this.browserOnly = true;
    }
    signal?.throwIfAborted();
    const t0 = performance.now();
    try {
      // The HTTP side's cookies go back to the browser first, so both sides hold the same jar.
      // shortcut: cookies the HTTP side deleted stay in the browser; port serpmaven's deletion list if Google starts relying on it.
      if (this.cookie) await this.browser.setCookies(this.cookie);
      const fetched = await this.browser.search(url);
      const verdict = classify(fetched.html, fetched.url, fetched.status ?? undefined);
      if (verdict.kind === "serp") this.cookie = await this.browser.cookies();
      return { fetched, verdict, via: "browser" };
    } finally {
      ms.browser = (ms.browser ?? 0) + performance.now() - t0;
    }
  }

  /** One link lookup on this identity's HTTP client and cookies; redirects are not followed. */
  async lookup(url: string, signal?: AbortSignal): Promise<LinkAnswer> {
    const headers = this.browser.headers;
    if (!headers) throw new Error("no captured browser headers");
    const r = await this.http.get(url, clickHeaders(replayHeaders(headers, this.cookie), new URL(url).origin + "/"), signal);
    this.cookie = foldCookies(this.cookie, r.setCookies);
    const status = r.status ?? 0;
    return { status, location: status >= 300 && status < 400 ? r.url : "", body: r.html };
  }
}
