// Records as markdown or plain text, for the API's `format` and the CLI's `--format markdown`.
// Plain text is the same content without markdown syntax, kept compact for an LLM's context.
import { type Extracted, plainText } from "./extract/index.js";
import type { SerpRecord } from "./types.js";

export type RenderFormat = "markdown" | "text";
type Obj = Record<string, any>;

const list = (v: unknown): Obj[] => (Array.isArray(v) ? v : []);
const join = (parts: unknown[], sep = ", ") => parts.filter((p) => p != null && p !== "").join(sep);

function page(r: SerpRecord, md: boolean): string {
  const p = r.search_parameters;
  const out: string[] = [];
  const heading = `${p.q}${p.page > 1 ? ` (page ${p.page})` : ""}`;
  out.push(md ? `# ${heading}` : heading);
  const section = (title: string, lines: string[]) => {
    if (lines.length) out.push("", md ? `## ${title}` : `${title}:`, ...lines);
  };
  const link = (title: string, url: unknown) =>
    md && url ? `[${title.replace(/[[\]]/g, "\\$&")}](${String(url).replace(/[ ()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)})` : title;

  if (r.search_metadata.status !== "Success" || r.error !== undefined) {
    out.push("", `Error: ${r.error ?? "search failed"}`);
    return out.join("\n");
  }
  const organic = list(r.organic_results);
  if (organic.length) out.push("");
  organic.forEach((o, i) => {
    if (organic[i - 1]?.extracted) out.push("");
    out.push(`${i + 1}. ${link(o.title, o.link)}`);
    // Markdown carries the URL in the link, so it shows the displayed link; text shows the URL itself.
    const site = md ? o.displayed_link : (o.link ?? o.displayed_link);
    for (const line of [site, o.snippet]) if (line) out.push(`   ${line}`);
    // `extract=N`: the page's content, indented under its result.
    const ex = o.extracted as Obj | undefined;
    if (ex) {
      const body = md ? (ex.markdown ?? "") : plainText(ex.markdown ?? "");
      const lines = body ? body.split("\n") : [`(extraction failed: ${ex.error ?? "no content"})`];
      out.push("", ...lines.map((l: string) => (l ? `   ${l}` : "")));
    }
  });
  section("Ads", list(r.ads).map((a) => `- ${link(a.title, a.link)} ${(md ? a.displayed_link : a.link) ?? ""}`.trimEnd()));
  section(
    "Local results",
    list(r.local_results).map((l) => {
      const rating = l.rating != null ? `${l.rating}${l.reviews != null ? ` (${l.reviews} reviews)` : ""}` : undefined;
      return `- ${join([l.title, rating, l.type, l.address, l.phone, l.hours])}`;
    }),
  );
  const overview = (r.ai_overview as Obj | undefined)?.text;
  section("AI overview", overview ? [overview] : []);
  section("Related questions", list(r.related_questions).map((q) => `- ${q.question}`));
  section("Related searches", list(r.related_searches).map((s) => `- ${s.query}`));
  return out.join("\n");
}

/** Every record, in order, separated by a blank line; ends with a newline. */
export function render(records: SerpRecord[], format: RenderFormat): string {
  return `${records.map((r) => page(r, format === "markdown")).join("\n\n")}\n`;
}

/** Extracted pages as one body: a single page as is, several under a heading per URL; ends with a newline. */
export function renderPages(pages: Extracted[], format: RenderFormat): string {
  const body = (p: Extracted) => (format === "markdown" ? p.markdown : p.text) || `Error: ${p.error ?? "no content"}`;
  if (pages.length === 1) return `${body(pages[0]!)}\n`;
  return `${pages.map((p) => `${format === "markdown" ? `# ${p.url}` : p.url}\n\n${body(p)}`).join("\n\n")}\n`;
}
