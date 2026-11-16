// Read results out of DuckDuckGo's HTML endpoint (html.duckduckgo.com/html/).
// Page 1 links are `//duckduckgo.com/l/?uddg=<url>` redirects; later pages link directly.

import { load } from "cheerio";
import type { OrganicResult } from "./index.js";

export interface DdgParsed {
  organic_results: OrganicResult[];
  /** The hidden inputs of the "Next" form (q, s, vqd, ...), to POST for the next page; null when there is none. */
  next: Record<string, string> | null;
}

/** DuckDuckGo's refusal: HTTP 202 with its captcha ("anomaly") page. */
export function ddgAnomaly(status: number | null, html: string): boolean {
  return status === 202 || html.includes("anomaly");
}

export function parseDdg(html: string): DdgParsed {
  const $ = load(html);
  const organic_results: OrganicResult[] = [];
  $("#links .result").each((_, el) => {
    const block = $(el);
    if (block.hasClass("result--ad")) return;
    const a = block.find("a.result__a").first();
    const href = a.attr("href");
    if (!href) return;
    const result: OrganicResult = { position: organic_results.length + 1, title: clean(a.text()), link: destination(href) };
    const displayed = clean(block.find(".result__url").first().text());
    if (displayed) result.displayed_link = displayed;
    const snippet = clean(block.find(".result__snippet").first().text());
    if (snippet) result.snippet = snippet;
    organic_results.push(result);
  });
  let next: Record<string, string> | null = null;
  const form = $(".nav-link form").filter((_, f) => $(f).find("input[type=submit]").attr("value") === "Next").first();
  if (form.length) {
    next = {};
    form.find("input[type=hidden][name]").each((_, i) => void (next![$(i).attr("name")!] = $(i).attr("value") ?? ""));
  }
  return { organic_results, next };
}

/** The real URL behind a `/l/?uddg=` redirect; other links as they are. */
function destination(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const target = u.pathname === "/l/" ? u.searchParams.get("uddg") : null;
    return target ?? u.href;
  } catch {
    return href;
  }
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
