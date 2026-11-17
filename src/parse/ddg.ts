// Read results out of DuckDuckGo's HTML endpoint (html.duckduckgo.com/html/).
// Links are `//duckduckgo.com/l/?uddg=<url>` redirects.

import { load } from "cheerio";
import type { OrganicResult } from "./index.js";

export interface DdgParsed {
  organic_results: OrganicResult[];
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
  return { organic_results };
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
