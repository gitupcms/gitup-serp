// Result pages as clean markdown for LLM/RAG use, like karust/openserp's `extract`.
//
// Pages are fetched with curl-impersonate through the scraper's egress (the Cloudflare tunnel or
// SCRAPER_PROXY), never from this machine's own address. Over the tunnel, a site the Workers cannot
// reach over TCP (Cloudflare-hosted) is retried once with a Worker's own fetch().

import { runBinary } from "cuimp";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import TurndownService from "turndown";
import { DDG_CURL } from "../scraper/ddg.js";
import { type ProxyEndpoint, ProxyTemplate, newSessionId, redact } from "../scraper/proxy.js";

export const MAX_REDIRECTS = 5;
export const TIMEOUT_S = 20;
export const MAX_BYTES = 3 * 1024 * 1024;
export const MIN_CHARS = 200;

export type Extracted = {
  url: string;
  status: number | null;
  title?: string;
  description?: string;
  lang?: string;
  canonical?: string;
  markdown: string;
  text: string;
  error?: string;
  /** Which path served the last hop. */
  via?: Via;
};

export type Via = "tunnel" | "worker-fetch" | "proxy";

/** One HTTP hop; redirects are not followed here, `extractPage` follows them. */
export interface PageResponse {
  status: number;
  /** Lower-cased names. */
  headers: Record<string, string>;
  body: Buffer;
  via?: Via;
}

export interface PageHttp {
  get(url: string, signal?: AbortSignal): Promise<PageResponse>;
}

export interface ExtractOptions {
  signal?: AbortSignal;
  minChars?: number;
  /** Default: no egress, so every page fails with NO_EGRESS; pass `egressHttp(proxyUrl)`. */
  http?: PageHttp;
}

/** The last response head of curl's `-i` output, and the body after it. */
export function parseResponse(buf: Buffer): PageResponse {
  let rest = buf;
  for (;;) {
    const sep = rest.indexOf("\r\n\r\n");
    if (sep < 0) throw new Error("curl returned no HTTP response");
    const lines = rest.subarray(0, sep).toString("latin1").split("\r\n");
    rest = rest.subarray(sep + 4);
    const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
    if (status >= 100 && status < 200) continue; // an interim response; the real one follows
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return { status, headers, body: rest };
  }
}

export const NO_EGRESS = "no egress: extraction goes through the egress only";
export const TARGET_REFUSED = "target refused by the egress (the site is likely on Cloudflare, which Workers cannot reach over TCP)";
export const PROXY_REFUSED = "target refused by the proxy";

function quote(s: string): string {
  if (/[\r\n]/.test(s)) throw new Error("newline in a curl config value");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** curl-impersonate's Chrome wrapper, which sends Chrome's own headers, through `proxy`. */
export class CurlPageHttp implements PageHttp {
  constructor(
    private readonly proxy?: ProxyEndpoint,
    private readonly bin = DDG_CURL,
    private readonly via: "tunnel" | "proxy" = "proxy",
  ) {}

  async get(url: string, signal?: AbortSignal): Promise<PageResponse> {
    // The URL and proxy go in a config on stdin, not argv: off the process list, and not parsed as options.
    const lines = ["silent", "show-error", "include", "suppress-connect-headers", `max-time = ${TIMEOUT_S}`, `max-filesize = ${MAX_BYTES}`, `url = ${quote(url)}`];
    if (this.proxy) {
      lines.push(`proxy = ${quote(this.proxy.server)}`);
      if (this.proxy.username) lines.push(`proxy-user = ${quote(`${this.proxy.username}:${this.proxy.password ?? ""}`)}`);
    }
    const r = await runBinary(this.bin, ["-K", "-"], { signal, stdin: lines.join("\n") + "\n" });
    if (r.exitCode === 63) throw new Error(`body over ${MAX_BYTES} bytes`);
    const stderr = r.stderr.toString("utf8").trim();
    // The tunnel answers CONNECT 403 when a Worker refuses the target, 502 when it cannot reach it.
    if (r.exitCode !== 0 && /CONNECT tunnel failed, response (?:403|502)/.test(stderr)) throw new Error(this.via === "tunnel" ? TARGET_REFUSED : PROXY_REFUSED);
    // Live: to a Cloudflare-hosted site the Worker accepts the CONNECT, then its socket dies in the TLS handshake.
    if (this.via === "tunnel" && r.exitCode === 35 && /SSL_ERROR_SYSCALL|closed abruptly/.test(stderr)) throw new Error(TARGET_REFUSED);
    if (r.exitCode !== 0) throw new Error(`curl exit ${r.exitCode}: ${redact(stderr)}`);
    return { ...parseResponse(r.stdout), via: this.via };
  }
}

/** `EgressTunnel.fetchVia`: one GET through a Worker's own fetch(), redirects not followed. */
export type FetchVia = (url: string, headers: Record<string, string>, signal?: AbortSignal) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;

// One current Chrome desktop set; Worker fetch() sends no browser headers of its own.
const CHROME_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

/** A Worker's fetch(): reaches Cloudflare-hosted sites, with Cloudflare's TLS fingerprint, not Chrome's. */
export class WorkerPageHttp implements PageHttp {
  constructor(private readonly fetchVia: FetchVia) {}

  async get(url: string, signal?: AbortSignal): Promise<PageResponse> {
    const timeout = AbortSignal.timeout(TIMEOUT_S * 1000);
    const r = await this.fetchVia(url, CHROME_HEADERS, signal ? AbortSignal.any([signal, timeout]) : timeout);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) headers[k.toLowerCase()] = v;
    return { status: r.status, headers, body: r.body, via: "worker-fetch" };
  }
}

/**
 * The extraction HTTP side over the egress proxy URL; without one every fetch fails, none goes direct.
 * With `fetchVia` (the Cloudflare tunnel), a URL the tunnel refuses is retried once through a Worker's fetch().
 */
export function egressHttp(proxyUrl?: string, fetchVia?: FetchVia): PageHttp {
  if (!proxyUrl) return { get: async () => { throw new Error(NO_EGRESS); } };
  const ep = new ProxyTemplate(proxyUrl).forSession(newSessionId());
  if (!fetchVia) return new CurlPageHttp(ep);
  const tunnel = new CurlPageHttp(ep, DDG_CURL, "tunnel");
  const worker = new WorkerPageHttp(fetchVia);
  return {
    get: (url, signal) =>
      tunnel.get(url, signal).catch((err: unknown) => {
        if (signal?.aborted || !(err instanceof Error) || err.message !== TARGET_REFUSED) throw err;
        return worker.get(url, signal);
      }),
  };
}

const DROP = "script, style, noscript, svg, iframe, form, nav, header, footer, aside, template, dialog";
const BOILERPLATE = /(?:^|[\s_-])(?:cookies?|banner|menu|sidebar|comments?|share|social|related|newsletter|ads?|advert\w*|promo)(?:$|[\s_-])/i;
const KEEP = new Set(["html", "body", "article", "main"]);

function absolute(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

/** The chosen content element: article, main, [role=main], the most paragraph text, or body. */
function mainContent($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> {
  const len = (el: AnyNode) => $(el).text().replace(/\s+/g, " ").trim().length;
  for (const sel of ["article", "main", "[role=main]"]) {
    const found = $(sel).toArray().filter((el) => len(el) > 0);
    if (found.length) return $(found.reduce((a, b) => (len(b) > len(a) ? b : a)));
  }
  const score = new Map<AnyNode, number>();
  $("p").each((_, p) => {
    const parent = p.parent;
    if (parent) score.set(parent, (score.get(parent) ?? 0) + len(p));
  });
  let best: AnyNode | undefined;
  for (const [el, n] of score) if (!best || n > score.get(best)!) best = el;
  return best ? $(best) : $("body");
}

function turndown(): TurndownService {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.addRule("img", { filter: "img", replacement: (_, node) => (node as HTMLElement).getAttribute("alt")?.trim() ?? "" });
  // shortcut: one pipe row per <tr>, no colspan or header detection; use turndown-plugin-gfm if tables matter.
  td.addRule("table", {
    filter: "table",
    replacement: (_, node) => {
      const rows = Array.from((node as HTMLElement).querySelectorAll("tr")).map(
        (tr) => `| ${Array.from(tr.querySelectorAll("th, td")).map((c) => (c.textContent ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()).join(" | ")} |`,
      );
      if (rows.length > 1) rows.splice(1, 0, rows[0]!.replace(/[^|]+/g, " --- "));
      return `\n\n${rows.join("\n")}\n\n`;
    },
  });
  return td;
}

/** Markdown to plain text: link targets, emphasis, heading and list markers dropped. */
export function plainText(md: string): string {
  return md
    .replace(/```[^\n]*\n/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\|\s*(?:---\s*\|\s*)+$/gm, "")
    .replace(/\s*\|\s*/g, " ")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** HTML to the page's metadata and main content as markdown; `url` resolves relative links. */
export function extractHtml(html: string, url: string): Omit<Extracted, "url" | "status" | "error"> {
  const $ = cheerio.load(html);
  const meta = (sel: string) => $(sel).attr("content")?.trim() || undefined;
  const base = absolute($("base[href]").attr("href") ?? "", url) ?? url;
  const canonicalHref = $('link[rel~="canonical"]').attr("href");
  const out: Omit<Extracted, "url" | "status" | "error"> = {
    title: $("title").first().text().trim() || meta('meta[property="og:title"]'),
    description: meta('meta[name="description"]') ?? meta('meta[property="og:description"]'),
    lang: $("html").attr("lang")?.trim() || undefined,
    canonical: canonicalHref ? absolute(canonicalHref, base) : undefined,
    markdown: "",
    text: "",
  };
  for (const k of ["title", "description", "lang", "canonical"] as const) if (!out[k]) delete out[k];

  $(DROP).remove();
  $("[class], [id], [role]").each((_, el) => {
    const e = el as Element;
    // A wrapper of the main content (e.g. VitePress's `VPContent has-sidebar`) is never boilerplate.
    if (KEEP.has(e.tagName) || $(el).find("main, article, [role=main]").length) return;
    const role = e.attribs.role ?? "";
    if (/^(?:navigation|banner|complementary|contentinfo|dialog|alert)$/.test(role) || BOILERPLATE.test(`${e.attribs.class ?? ""} ${e.attribs.id ?? ""}`)) $(el).remove();
  });
  $("a[href]").each((_, el) => {
    const href = absolute($(el).attr("href")!, base);
    if (href && /^https?:/.test(href)) $(el).attr("href", href);
    else $(el).removeAttr("href"); // javascript:, broken URLs: keep only the text
  });

  const content = mainContent($).html() ?? "";
  out.markdown = turndown().turndown(content).replace(/\n{3,}/g, "\n\n").trim();
  out.text = plainText(out.markdown);
  return out;
}

/** One page as markdown. Never throws except when `signal` aborts; failures go to `error`. */
export async function extractPage(url: string, opts: ExtractOptions = {}): Promise<Extracted> {
  const { signal, minChars = MIN_CHARS, http = egressHttp() } = opts;
  let current = url;
  let status: number | null = null;
  try {
    for (let hop = 0; ; hop++) {
      const u = new URL(current);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`unsupported URL scheme: ${u.protocol}`);
      const r = await http.get(u.href, signal);
      status = r.status;
      current = u.href;
      if (status >= 300 && status < 400 && r.headers.location) {
        if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
        current = new URL(r.headers.location, u).href;
        continue;
      }
      if (r.body.length > MAX_BYTES) throw new Error(`body over ${MAX_BYTES} bytes`);
      const type = (r.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      const via = r.via ? { via: r.via } : {};
      if (type && type !== "text/html" && type !== "application/xhtml+xml") {
        return { url: current, status, markdown: "", text: "", error: `unsupported content type: ${type}`, ...via };
      }
      if (status < 200 || status >= 300) return { url: current, status, markdown: "", text: "", error: `HTTP ${status}`, ...via };
      // shortcut: bodies are read as UTF-8; decode by the charset header/meta if non-UTF-8 sites show up garbled.
      const page: Extracted = { url: current, status, ...extractHtml(r.body.toString("utf8"), current), ...via };
      if (page.text.length < minChars) page.error = `little content (${page.text.length} chars); the page may need JavaScript`;
      return page;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    return { url: current, status, markdown: "", text: "", error: redact(err instanceof Error ? err.message : String(err)) };
  }
}

/** Several pages, `parallel` at a time; duplicates dropped, first-seen order kept. */
export async function extractMany(urls: string[], opts: ExtractOptions & { parallel?: number } = {}): Promise<Extracted[]> {
  const { parallel = 3, ...rest } = opts;
  const unique = [...new Set(urls)];
  const out: Extracted[] = new Array(unique.length);
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const i = next++;
      out[i] = await extractPage(unique[i]!, rest);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, parallel), unique.length) }, worker));
  return out;
}
