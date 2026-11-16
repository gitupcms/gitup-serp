// Read results out of a Google results page that `classify` called a SERP.
// Ported from serpmaven's parse.py (MIT). Field names follow the usual SERP API JSON.
//
// Google wraps result links in an encrypted `/goto?url=...` redirect. Some pages pair each
// token with its destination in their inline JSON; the parser reads that first, and a link it
// cannot find keeps its `redirect_link` for a caller to follow.

import { contains, load, type Cheerio, type CheerioAPI } from "cheerio";
// Type-only: domhandler is cheerio's own node model, nothing is loaded at runtime.
import type { AnyNode, Element } from "domhandler";
import { AI_OVERVIEW_HEADINGS, SELECTORS as S } from "./selectors.js";

const GOOGLE = "https://www.google.com";

export interface OrganicResult {
  position: number;
  title: string;
  link: string | null;
  redirect_link?: string;
  displayed_link?: string;
  source?: string;
  date?: string;
  snippet?: string;
}

export interface Ad {
  position: number;
  block_position: "top" | "bottom" | "unknown";
  title: string;
  link: string;
  displayed_link?: string;
  source?: string;
}

export interface PlaceFacts {
  address?: string;
  phone?: string;
  hours?: string;
}

export interface LocalResult extends PlaceFacts {
  position: number;
  title: string;
  rating?: number;
  reviews?: number;
  price?: string;
  type?: string;
  description?: string;
  extensions?: string[];
}

export interface Parsed {
  search_information: { total_results_text?: string; total_results?: number };
  ads: Ad[];
  organic_results: OrganicResult[];
  related_questions: { question: string }[];
  related_searches: { query: string; link: string }[];
  pagination: { next?: string; current?: number };
  ai_overview: { text?: string };
  local_results: LocalResult[];
  /** Every `/goto` token on the page that the inline JSON pairs with a destination. */
  goto_links: Record<string, string>;
  /** Each result anchor's `/goto` token, mapped to the same anchor's ping URL (`/url?...`). */
  ping_paths: Record<string, string>;
}

/**
 * Parse one results page. Missing blocks come back empty rather than absent, so a caller can
 * tell "this page had no ads" from "this parser has no ads field".
 */
export function parseSerp(html: string, hl: string): Parsed {
  const $ = load(html);
  return {
    search_information: searchInformation($),
    ads: ads($),
    organic_results: organic($, html),
    related_questions: relatedQuestions($),
    related_searches: relatedSearches($),
    pagination: pagination($),
    ai_overview: aiOverview($, hl),
    local_results: localResults($),
    goto_links: gotoLinks($, html),
    ping_paths: pingPaths($),
  };
}

// -- /goto resolution --------------------------------------------------------

// In the inline JSON a result reads `..."/goto?url=<token>"],["<destination>",...`.
const AFTER_TOKEN = String.raw`"\],\["(https?:[^"\\]*(?:\\.[^"\\]*)*)"`;
const JSON_URL = String.raw`"(https?:[^"\\]*(?:\\.[^"\\]*)*)"`;
// The video fallback reads at most this far past a token, and never into the next entry.
const WINDOW = 1500;
const NEXT_ENTRY = "[null,1,[null,null,5,";
const VIDEO_MARKER = '"VIDEO_RESULT"';

/**
 * The destination the page's inline JSON pairs with a /goto token, or null.
 * A web result puts it right after the token. A video result does not: its entry ends with
 * `["VIDEO_RESULT", ..., "https://www.youtube.com/..."]`, so the fallback takes the first
 * non-Google URL after that marker, within the token's own entry. With no marker the answer is
 * null: other URLs near a token (an SVG namespace, a thumbnail) would be confidently wrong.
 */
export function resolveGoto(page: string, token: string): string | null {
  if (!token) return null;
  const after = new RegExp(AFTER_TOKEN, "y");
  const occurrences: number[] = [];
  for (let i = page.indexOf(token); i >= 0; i = page.indexOf(token, i + 1)) {
    const end = i + token.length;
    after.lastIndex = end;
    const match = after.exec(page);
    const found = match ? unescapeJson(match[1]!) : null;
    if (found) return found;
    if (page.startsWith('"', end)) occurrences.push(end); // inside JSON, not an href
  }
  for (const end of occurrences) {
    let window = page.slice(end, end + WINDOW);
    const cut = window.indexOf(NEXT_ENTRY);
    if (cut >= 0) window = window.slice(0, cut);
    const marker = window.indexOf(VIDEO_MARKER);
    if (marker < 0) continue;
    for (const m of window.slice(marker).matchAll(new RegExp(JSON_URL, "g"))) {
      const url = unescapeJson(m[1]!);
      if (url && !isGoogle(url)) return url;
    }
  }
  return null;
}

function unescapeJson(s: string): string | null {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return null;
  }
}

function isGoogle(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  return (
    ["google.com", "gstatic.com", "googleusercontent.com"].some((d) => host.endsWith(d)) ||
    host.includes(".google.")
  );
}

function gotoLinks($: CheerioAPI, page: string): Record<string, string> {
  const map: Record<string, string> = {};
  $("a[href^='/goto']").each((_, a) => {
    const token = queryParam($(a).attr("href") ?? "", "url");
    if (!token || token in map) return;
    const dest = resolveGoto(page, token);
    if (dest) map[token] = dest;
  });
  return map;
}

function pingPaths($: CheerioAPI): Record<string, string> {
  const map: Record<string, string> = {};
  $("a[href^='/goto'][ping^='/url?']").each((_, a) => {
    const token = queryParam($(a).attr("href") ?? "", "url");
    if (token && !(token in map)) map[token] = $(a).attr("ping")!;
  });
  return map;
}

// -- blocks ------------------------------------------------------------------

function organic($: CheerioAPI, page: string): OrganicResult[] {
  const container = pickDoc($, S.organicContainer);
  if (!container) return [];
  const results: OrganicResult[] = [];
  const seen = new Set<string>();
  container.find("h3").each((_, h3) => {
    const anchor = $(h3)
      .parents("a[href]")
      .filter((_, a) => !!$(a).attr("href"))
      .first();
    if (!anchor.length || $(h3).closest(S.relatedQuestionAncestor.join(", ")).length) return;
    const [link, redirect] = destination(anchor.attr("href")!, page);
    const key = link ?? redirect;
    if (!key || seen.has(key)) return;
    seen.add(key);
    const block = resultBlock($, h3, anchor, container);
    const result: OrganicResult = { position: results.length + 1, title: text($(h3)), link };
    if (redirect) result.redirect_link = redirect;
    const cite = pick(block, S.displayedLink);
    if (cite) result.displayed_link = text(cite);
    const source = pick(block, S.source);
    if (source) result.source = text(source);
    const snippet = pick(block, S.snippet);
    if (snippet) {
      const date = pick(snippet, S.snippetDate);
      let body = text(snippet);
      if (date) {
        result.date = text(date);
        if (body.startsWith(result.date)) body = body.slice(result.date.length);
        body = body.replace(/^[ —\-·]+/, "");
      }
      result.snippet = body;
    }
    results.push(result);
  });
  return results;
}

/** The result's block: the class hint if present, else the largest ancestor holding only this heading. */
function resultBlock($: CheerioAPI, h3: Element, anchor: Cheerio<Element>, container: Cheerio<Element>): Cheerio<AnyNode> {
  for (const sel of S.resultBlock) {
    const hinted = $(h3).closest(sel);
    if (hinted.length && contains(container[0]!, hinted[0]!)) return hinted;
  }
  let block: Cheerio<AnyNode> = anchor;
  for (;;) {
    const parent = block.parent();
    if (!parent.length || parent[0] === container[0] || parent.find("h3").length > 1) return block;
    block = parent;
  }
}

function ads($: CheerioAPI): Ad[] {
  const out: Ad[] = [];
  for (const el of pickAllDoc($, S.adBlock)) {
    const block = $(el);
    const anchor = pick(block, S.adAnchor);
    if (!anchor) continue;
    const heading = pick(block, S.adHeading);
    const landing = (anchor.attr("data-pcu") ?? "").split(",")[0]!.trim();
    const ad: Ad = {
      position: out.length + 1,
      block_position: adBlockPosition(block),
      title: text(heading ?? anchor),
      link: landing || join(anchor.attr("href") ?? ""),
    };
    const displayed = pick(block, S.adDisplayed);
    if (displayed) {
      ad.displayed_link = text(displayed);
      const dtld = displayed.attr("data-dtld");
      if (dtld !== undefined) ad.source = dtld;
    }
    out.push(ad);
  }
  return out;
}

function adBlockPosition(block: Cheerio<Element>): Ad["block_position"] {
  for (const ancestor of block.parents().toArray()) {
    const id = ancestor.attribs.id;
    if (id === "tads") return "top";
    if (id === "tadsb" || id === "bottomads") return "bottom";
  }
  return "unknown";
}

function relatedQuestions($: CheerioAPI): { question: string }[] {
  const questions: { question: string }[] = [];
  const seen = new Set<string>();
  for (const el of pickAllDoc($, S.relatedQuestion)) {
    const question = ($(el).attr("data-q") ?? "").trim();
    if (question && !seen.has(question)) {
      seen.add(question);
      questions.push({ question });
    }
  }
  return questions;
}

function relatedSearches($: CheerioAPI): { query: string; link: string }[] {
  const container = pickDoc($, S.relatedSearchContainer);
  if (!container) return [];
  const searches: { query: string; link: string }[] = [];
  const seen = new Set<string>();
  container.find("a[href]").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    const query = queryParam(href, "q");
    if (!href.startsWith("/search") || !query || seen.has(query)) return;
    seen.add(query);
    searches.push({ query, link: join(href) });
  });
  return searches;
}

function pagination($: CheerioAPI): Parsed["pagination"] {
  const out: Parsed["pagination"] = {};
  const href = pickDoc($, S.nextPage)?.attr("href");
  if (href) {
    out.next = join(href);
    const start = queryParam(href, "start");
    if (start && /^\d+$/.test(start)) out.current = Math.floor(Number(start) / 10);
  }
  return out;
}

function searchInformation($: CheerioAPI): Parsed["search_information"] {
  const info: Parsed["search_information"] = {};
  const stats = pickDoc($, S.resultStats);
  if (stats) {
    const t = text(stats);
    info.total_results_text = t;
    // "Page 2 of about 1,230,000 results (0.42 seconds)": drop the timing, then the largest
    // number is the count, in any digit grouping.
    const counts = t.replace(/\(.*?\)/g, "").match(/\d[\d,.   ]*\d|\d/g) ?? [];
    const numbers = counts.map((c) => Number(c.replace(/\D/g, "")));
    if (numbers.length) info.total_results = Math.max(...numbers);
  }
  return info;
}

// -- AI Overview -------------------------------------------------------------

// Interface text inside the AI Overview block, not part of the answer.
// shortcut: English only, like the original; add per-hl strings if other languages leak chrome into the text.
const AI_CHROME = [
  "AI responses may include mistakes.",
  "Learn more",
  "Show more",
  "Show all",
  "Dive deeper in AI Mode",
  "Thank you",
  "Your feedback helps Google improve.",
  "Share public link",
  "Copy link",
  "Link copied",
  "Copied to clipboard",
  "Failed to copy to clipboard. Try again later.",
  "Can’t copy the link right now. Try again later.",
  "Facebook",
  "Gmail",
  "Reddit",
  "WhatsApp",
  "LinkedIn",
];
const AI_MIN_TEXT = 200;
const HIDDEN_ROLES = ["dialog", "status", "menu", "alert", "tooltip"].map((r) => `[role='${r}']`).join(", ");
const HIDDEN_PREFIXES = ["AI responses may include mistakes", "This public link is valid"];
const REPLIED = "AI Mode replied:";
const LABEL_PREFIXES = ["AI Mode reply for", REPLIED];
const BLOCK_TAGS = new Set(["div", "p", "button", "li", "ul", "section", "footer", "g-more-link"]);

function headingsFor(hl: string): string[] {
  const lang = hl.toLowerCase().split(/[-_]/)[0] ?? "";
  return [...(AI_OVERVIEW_HEADINGS[lang] ?? []), ...(AI_OVERVIEW_HEADINGS.en ?? [])];
}

/**
 * The AI Overview's text, or {} when the page has none. A structural container is tried first;
 * failing that, the visible heading in the page's language or English, climbing to the nearest
 * ancestor that holds real text. Source links load later by script and are not in the page.
 */
function aiOverview($: CheerioAPI, hl: string): { text?: string } {
  const headings = headingsFor(hl);
  for (const sel of S.aiOverview) {
    const el = $(sel).first();
    if (!el.length) continue;
    const t = overviewText($, el[0]!, headings);
    if (t.length >= AI_MIN_TEXT) return { text: t };
  }
  const heading = $("*")
    .toArray()
    .filter(isElement)
    .find((el) => (el.type as string) === "tag" && headings.includes(leadText(el).trim()));
  if (!heading) return {};
  let block: Element = heading;
  for (let step = 0; step < 10; step++) {
    const parent = block.parent;
    if (!parent || !isElement(parent)) return {};
    block = parent;
    // An ancestor holding a result link is past the block: stopping there keeps an empty
    // overview from borrowing the results' text.
    if ($(block).find("a:has(h3)").length) return {};
    const t = overviewText($, block, headings);
    if (t.length >= AI_MIN_TEXT) return { text: t };
  }
  return {};
}

/** The answer text of an AI Overview block, without its heading and label. */
function overviewText($: CheerioAPI, block: Element, headings: string[]): string {
  let t = visibleText($, block, true);
  const h = headings.find((x) => t.startsWith(x));
  if (h) t = t.slice(h.length);
  return t.trim();
}

/** Text without scripts, styles, the hidden label before the answer, panels and interface labels. */
function visibleText($: CheerioAPI, el: Element, skipLabel: boolean): string {
  const copy = $(el).clone();
  copy.find("script, style").remove();
  if (skipLabel) {
    copy.find("*").each((_, node) => {
      const lead = norm(leadText(node).replace(/ /g, " "));
      if (!LABEL_PREFIXES.some((p) => lead.startsWith(p))) return;
      const rest = lead.startsWith(REPLIED) ? lead.slice(REPLIED.length).trim() : "";
      if (rest || node.children.some(isElement)) {
        // The answer shares the label's element: only the label goes.
        const first = node.children[0];
        if (first && first.type === "text") {
          if (rest) (first as { data: string }).data = rest;
          else $(first).remove();
        }
      } else {
        $(node).remove();
      }
    });
    // Panels the block opens on demand (sharing, feedback, a "copied" notice). Hidden parts are
    // not dropped: the answer behind "Show more" is hidden too.
    copy.find(HIDDEN_ROLES).remove();
    copy
      .find("*")
      .filter((_, node) => HIDDEN_PREFIXES.some((p) => norm(leadText(node)).startsWith(p)))
      .remove();
    // The block's own buttons and notices, only where an element holds nothing else.
    copy
      .find("*")
      .filter((_, node) => onlyChrome($, node) && standsAlone($, node))
      .remove();
  }
  // Text nodes joined with a space: block elements carry no separator of their own.
  return norm(textNodes(copy[0]!).join(" "));
}

function onlyChrome($: CheerioAPI, el: Element): boolean {
  let rest = text($(el));
  if (!rest) return false;
  for (const chrome of AI_CHROME) rest = rest.replaceAll(chrome, "");
  return rest.replace(/^[ .]+|[ .]+$/g, "") === "";
}

/** Not part of a sentence: a block of its own, or an inline element alone in its parent. */
function standsAlone($: CheerioAPI, el: Element): boolean {
  if (BLOCK_TAGS.has(el.name) || el.attribs.role === "button") return true;
  const parent = el.parent;
  if (!parent || !isElement(parent) || onlyChrome($, parent)) return true;
  return text($(parent)) === text($(el));
}

// -- local results -----------------------------------------------------------

const RATING = /(\d+(?:[.,]\d+)?)/;
const COUNT = /^\(?\s*([\d.,]+)\s*([KkMm]?)\s*\)?$/;
const PHONE = /^\+?[\d\s().-]{7,}$/;
const HOURS =
  /^(open|closed|closes|opens|temporarily closed)\b|^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(rs?)?|fri|sat|sun)\b|\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i;
// An address starts with a house number or carries a comma or a plus code; service options
// ("Dine-in") and offers ("Rentals available from US$ 44/day") do not.
const ADDRESS_LIKE = /^\d|,|\b[2-9C-X]{4}\+[2-9C-X]{2,3}\b/;
const SERVICE_OPTIONS = new Set([
  "dine-in",
  "takeout",
  "delivery",
  "curbside pickup",
  "no-contact delivery",
  "in-store shopping",
  "in-store pickup",
  "onsite services",
  "online appointments",
  "drive-through",
]);

/** "(1.7K)" -> 1700, "(44)" -> 44. */
export function reviewCount(s: string): number | null {
  const found = COUNT.exec(s.trim());
  if (!found) return null;
  const number = found[1]!;
  const scale = ({ k: 1_000, m: 1_000_000 } as Record<string, number>)[found[2]!.toLowerCase()] ?? 1;
  if (scale > 1) {
    const n = Number(number.replaceAll(",", "."));
    return Number.isFinite(n) ? Math.round(n * scale) : null;
  }
  const digits = number.replaceAll(",", "").replaceAll(".", "");
  return digits ? Number(digits) : null;
}

/**
 * Address, phone and hours out of the lines under a place's name. A line holds facts joined
 * by middle dots. The address is the first fact that looks like one and is neither a phone
 * number nor hours; a plain first fact ("Broadway") is the address when nothing else is.
 */
export function placeFacts(lines: string[]): PlaceFacts {
  const facts: PlaceFacts = {};
  const hours: string[] = [];
  let plain: string | undefined;
  lines.forEach((line, index) => {
    for (const raw of line.split(/[·⋅]/)) {
      const part = raw.trim();
      if (!part) continue;
      const digits = (part.match(/\d/g) ?? []).length;
      if (facts.phone === undefined && PHONE.test(part) && digits >= 7) facts.phone = part;
      else if (HOURS.test(part)) hours.push(part);
      else if (facts.address === undefined && ADDRESS_LIKE.test(part)) facts.address = part;
      else if (plain === undefined && index === 0 && !SERVICE_OPTIONS.has(part.toLowerCase())) plain = part;
    }
  });
  if (facts.address === undefined && plain !== undefined) facts.address = plain;
  if (hours.length) facts.hours = hours.join(" · ");
  return facts;
}

/** The map pack's places, in the order shown. */
function localResults($: CheerioAPI): LocalResult[] {
  const places: LocalResult[] = [];
  for (const el of pickAllDoc($, S.localDetails)) {
    const details = $(el);
    const heading = pick(details, S.localHeading);
    if (!heading) continue;
    const place: LocalResult = { position: places.length + 1, title: text(heading) };
    const rating = pick(details, S.localRating);
    const lines = details
      .children("div")
      .toArray()
      .filter((line) => line !== heading[0]);
    for (const line of lines) {
      if (rating && contains(line, rating[0]!)) {
        const spans = rating.children("span");
        const found = RATING.exec(spans.length ? text(spans.first()) : "");
        if (found) place.rating = Number(found[1]!.replace(",", "."));
        // The review count is the span in brackets; the star value alone is not one.
        const count = spans.filter((_, s) => text($(s)).startsWith("(")).first();
        const reviews = count.length ? reviewCount(text(count)) : null;
        if (reviews !== null) place.reviews = reviews;
        const parts = text($(line))
          .split("·")
          .slice(1)
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.length >= 2) place.price = parts[0]!;
        if (parts.length) place.type = parts[parts.length - 1]!;
      } else if (S.localQuote.some((sel) => $(line).is(sel))) {
        const quote = text($(line)).replace(/^[ "“”]+|[ "“”]+$/g, "");
        if (quote) place.description = quote;
      } else {
        const t = text($(line));
        if (t) (place.extensions ??= []).push(t);
      }
    }
    Object.assign(place, placeFacts(place.extensions ?? []));
    places.push(place);
  }
  return places;
}

// -- helpers -----------------------------------------------------------------

/** Return [link, redirect_link] for a result anchor's href. */
function destination(href: string, page: string): [string | null, string | null] {
  if (href.startsWith("/goto")) {
    const token = queryParam(href, "url");
    return [token ? resolveGoto(page, token) : null, join(href)];
  }
  if (href.startsWith("/url")) return [queryParam(href, "q") ?? queryParam(href, "url"), join(href)];
  if (/^https?:\/\//.test(href)) return [href, null];
  return [null, null];
}

function join(href: string): string {
  try {
    return new URL(href, GOOGLE).href;
  } catch {
    return href;
  }
}

function queryParam(href: string, name: string): string | null {
  try {
    return new URL(href, GOOGLE).searchParams.get(name) || null;
  } catch {
    return null;
  }
}

function pick(ctx: Cheerio<AnyNode>, chain: readonly string[]): Cheerio<Element> | null {
  for (const sel of chain) {
    const found = ctx.find(sel).first();
    if (found.length) return found;
  }
  return null;
}

function pickDoc($: CheerioAPI, chain: readonly string[]): Cheerio<Element> | null {
  return pick($.root(), chain);
}

/** All matches of the first selector in the chain that matches anything. */
function pickAllDoc($: CheerioAPI, chain: readonly string[]): Element[] {
  for (const sel of chain) {
    const found = $(sel).toArray().filter(isElement);
    if (found.length) return found;
  }
  return [];
}

function isElement(node: AnyNode): node is Element {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

/** Text before an element's first child element, like lxml's `el.text`. */
function leadText(el: Element): string {
  const first = el.children[0];
  return first && first.type === "text" ? (first as { data: string }).data : "";
}

function textNodes(node: AnyNode): string[] {
  if (node.type === "text") return [(node as { data: string }).data];
  if ("children" in node) return node.children.flatMap(textNodes);
  return [];
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function text(el: Cheerio<AnyNode>): string {
  return norm(el.text());
}
