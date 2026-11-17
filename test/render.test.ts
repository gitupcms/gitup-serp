import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { dateSchema, dateTbs } from "../src/config.js";
import { parseSerp } from "../src/parse/index.js";
import { render, renderPages } from "../src/render.js";
import type { SerpRecord } from "../src/types.js";

const load = (name: string) => gunzipSync(readFileSync(new URL(`fixtures/${name}.html.gz`, import.meta.url))).toString();

function fromFixture(name: string, q: string, page = 1): SerpRecord {
  const { goto_links: _g, ping_paths: _p, ...parsed } = parseSerp(load(name), "en");
  return {
    search_metadata: {
      id: "x",
      status: "Success",
      created_at: "",
      total_time_taken: 0,
      google_url: null,
      page_verdict: "serp",
      verdict_reason: null,
    },
    search_parameters: { q, page, hl: "en", engine: "google", device: "desktop" },
    ...parsed,
  };
}

describe("render", () => {
  const r = fromFixture("car-insurance-quote", "car insurance quote");
  const organic = r.organic_results as { title: string; link: string | null; displayed_link?: string }[];
  // The fixture's links are unresolved /goto redirects; give the first one its destination.
  const first = organic[0]!;
  first.link = "https://example.com/a (b)";

  it("markdown: heading, numbered linked results, ads and related blocks", () => {
    const md = render([r], "markdown");
    expect(md.startsWith("# car insurance quote\n\n1. [")).toBe(true);
    expect(md).toContain(`1. [${first.title}](https://example.com/a%20%28b%29)\n   ${first.displayed_link}\n`);
    expect(md).toContain(`\n2. ${organic[1]!.title}\n`);
    expect(md).toContain("\n## Ads\n- [");
    expect(md).toContain("\n## Related questions\n- ");
    expect(md).toContain("\n## Related searches\n- ");
    expect(md.match(/^\d+\. /gm)!.length).toBe(organic.length);
  });

  it("text: same content without markdown syntax", () => {
    const text = render([r], "text");
    expect(text.startsWith("car insurance quote\n\n1. ")).toBe(true);
    expect(text).toContain(`   ${first.link}`);
    expect(text).toContain("\nAds:\n- ");
    expect(text).toContain("\nRelated searches:\n- ");
    expect(text).not.toMatch(/^#|\]\(/m);
  });

  it("renders every page in order, and errors", () => {
    const err = { ...r, search_metadata: { ...r.search_metadata, status: "Error" as const }, error: "blocked" };
    const out = render([r, { ...err, search_parameters: { ...r.search_parameters, page: 2 } }], "markdown");
    expect(out.indexOf("# car insurance quote\n")).toBeLessThan(out.indexOf("# car insurance quote (page 2)\n\nError: blocked"));
  });

  it("includes the local pack", () => {
    const pizza = render([fromFixture("pizza-near-me", "pizza near me")], "text");
    expect(pizza).toContain("\nLocal results:\n- ");
  });
});

describe("render with extracted pages", () => {
  const rec = {
    search_metadata: { id: "x", status: "Success", created_at: "", total_time_taken: 0, google_url: null, page_verdict: "serp", verdict_reason: null },
    search_parameters: { q: "q", page: 1, hl: "en", engine: "google", device: "desktop" },
    organic_results: [
      { title: "A", link: "https://a.example/", extracted: { markdown: "## Intro\n\nSome **bold** text.", title: "A page" } },
      { title: "B", link: "https://b.example/", extracted: { markdown: "", error: "HTTP 500" } },
      { title: "C", link: "https://c.example/" },
    ],
  } as unknown as SerpRecord;

  it("markdown indents each page under its result", () => {
    expect(render([rec], "markdown")).toBe(
      "# q\n\n1. [A](https://a.example/)\n\n   ## Intro\n\n   Some **bold** text.\n\n2. [B](https://b.example/)\n\n   (extraction failed: HTTP 500)\n\n3. [C](https://c.example/)\n",
    );
  });

  it("text drops the markdown syntax", () => {
    const t = render([rec], "text");
    expect(t).toContain("1. A\n   https://a.example/\n\n   Intro\n\n   Some bold text.\n\n2. B");
  });

  it("renderPages: one body as is, several under a heading per URL", () => {
    const a = { url: "https://a.example/", status: 200, markdown: "# A", text: "A" };
    const b = { url: "https://b.example/", status: null, markdown: "", text: "", error: "boom" };
    expect(renderPages([a], "markdown")).toBe("# A\n");
    expect(renderPages([a, b], "markdown")).toBe("# https://a.example/\n\n# A\n\n# https://b.example/\n\nError: boom\n");
    expect(renderPages([a, b], "text")).toBe("https://a.example/\n\nA\n\nhttps://b.example/\n\nError: boom\n");
  });
});

describe("date filter", () => {
  it.each([
    ["h", undefined, "qdr:h"],
    ["y", undefined, "qdr:y"],
    ["d", "li:1", "li:1,qdr:d"],
    ["20240105..20241231", undefined, "cdr:1,cd_min:1/5/2024,cd_max:12/31/2024"],
  ])("%s with tbs %s → %s", (date, tbs, out) => {
    expect(dateSchema.safeParse(date).success).toBe(true);
    expect(dateTbs(date, tbs)).toBe(out);
  });

  it.each(["x", "hh", "2024-01-01..2024-02-01", "20240230..20240301", "20240301..20240201", ""])("rejects %j", (date) => {
    expect(dateSchema.safeParse(date).success).toBe(false);
  });
});
