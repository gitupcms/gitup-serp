// Decide what Google served before anything tries to read results out of it.
// Ported from serpmaven's classify.py and quality.py (MIT).
//
// A refusal must never reach the parser: "Google found nothing" and "Google refused this exit"
// need opposite responses. Mostly structural markers (ids, paths, endpoints) are used; the one
// text marker, the unusual-traffic sentence, is matched in several languages.
// A page with no SERP container and no block marker is `unknown`, never `block`.

import type { Verdict } from "../types.js";

/** The unusual-traffic sentence of Google's /sorry/ page, lower-cased, per language. */
const UNUSUAL_TRAFFIC: Record<string, string> = {
  en: "unusual traffic from your computer",
  tr: "olağan dışı trafik",
  de: "ungewöhnlichen datenverkehr",
  fr: "trafic exceptionnel",
  es: "tráfico inusual",
};

const hasId = (low: string, id: string) => new RegExp(`[\\s"']id\\s*=\\s*["']?${id}["'\\s/>]`).test(low);

/**
 * Classify one Google response from its body and final URL.
 * Order matters: a served page can carry a dormant consent panel, so the results test runs
 * before the inline consent test.
 */
export function classify(html: string, finalUrl: string, status?: number): Verdict {
  // Status first, as serpmaven does: Google's 429 is the /sorry/ refusal even when the body is odd.
  if (status === 429) return { kind: "sorry", reason: "HTTP 429" };
  if (status === 403) return { kind: "block", reason: "HTTP 403" };
  if (!html) return { kind: "empty", reason: "no body" };

  let host = "";
  let path = "";
  try {
    const url = new URL(finalUrl);
    host = url.hostname.toLowerCase();
    path = url.pathname.toLowerCase();
  } catch {
    // No usable URL: decide from the body alone.
  }
  const low = html.toLowerCase();

  // The refusal redirects to /sorry/ with a reCAPTCHA, as 429 or as 200 with the same body.
  if (host.startsWith("sorry.") || path.startsWith("/sorry")) {
    return { kind: "sorry", reason: "redirected to /sorry/ with a captcha" };
  }
  // A redirect stub that was not followed: a tiny body pointing at /sorry/.
  if (html.length < 2000 && low.includes("/sorry/")) {
    return { kind: "sorry", reason: "short body pointing at /sorry/" };
  }
  if (hasId(low, "captcha-form")) return { kind: "sorry", reason: "captcha form" };
  for (const [lang, phrase] of Object.entries(UNUSUAL_TRAFFIC)) {
    if (low.includes(phrase)) return { kind: "sorry", reason: `unusual-traffic page (${lang})` };
  }
  if (host.startsWith("consent.")) return { kind: "consent", reason: "consent interstitial" };

  if (hasId(low, "rso")) return { kind: "serp", reason: "results container present" };
  // A real empty SERP keeps `#search`; retiring an exit on it would waste a working identity.
  if (hasId(low, "search")) return { kind: "serp", reason: "search container present, no results in it" };

  if (low.includes("consent.google.com")) {
    return { kind: "consent", reason: "consent wall served inline, no results behind it" };
  }
  // The "enable JavaScript" scaffold also carries `emsg=SG_REL`, so it is tested before the wall.
  if (low.includes("enablejs")) return { kind: "no_js", reason: "served the no-JavaScript scaffold" };
  // A SERP-shaped page with an error marker and no results container: a refusal without redirect.
  if (low.includes("emsg=sg_rel")) return { kind: "wall", reason: "SERP-shaped wall without results (emsg=SG_REL)" };
  if (low.includes("<noscript") && !low.includes("<h3")) {
    return { kind: "no_js", reason: "a scaffold with no results and a noscript block" };
  }
  if (low.includes("error 403")) return { kind: "block", reason: "HTTP 403 page" };
  return { kind: "unknown", reason: "no results container and no known block marker" };
}

// -- quality: is a served page about the query? ------------------------------
// Google is reported to answer some automated traffic with a normal-looking page of results for
// other queries. A single such page happens on honest exits too; the caller decides over a window.

/** Below this share of titles holding half of the query's words, a page is unrelated. */
export const POISON_RELEVANCE = 0.2;
export const MIN_WORDS = 2;
const STOP_WORDS = new Set(
  "how to the a an of for and in on is what are best with do does you your my can i vs".split(" "),
);
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
const NOT_AFTER_WORD = "(?<![\\p{L}\\p{N}\\p{M}])";
// A slash, hyphen or dot inside a word ("Pub/Sub", "Node.js"), not between two digits ("3.5").
const JOINER = /(?<=[\p{L}\p{M}])[/.\-](?=[\p{L}\p{N}\p{M}])|(?<=\p{N})[/.\-](?=[\p{L}\p{M}])/gu;
const JOINED = /[\p{L}\p{N}\p{M}]+(?:[/.\-][\p{L}\p{N}\p{M}]+)+/gu;

/** Plural and verb endings off, so "puppies" finds "puppy" in a title. */
function stem(word: string): string {
  for (const suffix of ["ies", "es", "s", "ing", "ed"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  }
  return word;
}

function words(query: string): string[] {
  return (query.toLowerCase().match(WORD) ?? []).filter((w) => !STOP_WORDS.has(w) && w.length > 2).map(stem);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Share of titles holding at least half of the query's content words; 1 when nothing to compare. */
export function relevance(query: string, titles: string[]): number {
  const ws = words(query);
  if (!ws.length || !titles.length) return 1;
  const need = Math.max(1, Math.floor((ws.length + 1) / 2));
  // At the start of a title word, so "cat" is not found in "education".
  const found = ws.map((w) => new RegExp(NOT_AFTER_WORD + escapeRe(w), "u"));
  // A joined query term ("pub/sub") is also looked for closed up ("pubsub").
  const joined: [RegExp, string[]][] = [];
  for (const term of query.toLowerCase().match(JOINED) ?? []) {
    const parts = term.split(JOINER);
    if (parts.length > 1) {
      joined.push([new RegExp(NOT_AFTER_WORD + escapeRe(parts.map(stem).join("")), "u"), words(term)]);
    }
  }
  const hits = (title: string): number => {
    const forms = [title.toLowerCase(), title.toLowerCase().replace(JOINER, "")];
    const hit = found.map((f) => forms.some((form) => f.test(form)));
    for (const [pattern, parts] of joined) {
      if (!forms.some((form) => pattern.test(form))) continue;
      for (const part of parts) {
        const i = ws.findIndex((w, j) => w === part && !hit[j]);
        if (i >= 0) hit[i] = true;
      }
    }
    return hit.filter(Boolean).length;
  };
  return titles.filter((t) => hits(t) >= need).length / titles.length;
}

/** Whether the titles are unrelated to the query; null when there is too little to tell. */
export function unrelated(query: string, titles: string[]): boolean | null {
  if (words(query).length < MIN_WORDS || !titles.length) return null;
  return relevance(query, titles) < POISON_RELEVANCE;
}
