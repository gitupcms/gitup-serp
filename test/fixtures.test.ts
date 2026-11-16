// Real Google pages saved with SAVE_HTML (gl=us, hl=en, Cloudflare egress, 2026-11-16).
// When Google changes its markup, refresh these and see which assertion breaks.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { classify } from "../src/classify/index.js";
import { parseSerp } from "../src/parse/index.js";

const load = (name: string) => gunzipSync(readFileSync(new URL(`fixtures/${name}.html.gz`, import.meta.url))).toString();
const URL_ = "https://www.google.com/search?q=x";

describe("real Google fixtures", () => {
  it("car insurance quote: top ads and organic results", () => {
    const html = load("car-insurance-quote");
    expect(classify(html, URL_, 200).kind).toBe("serp");
    const r = parseSerp(html, "en");
    expect(r.ads.length).toBe(2);
    expect(r.ads[0]!.title).toMatch(/insur/i);
    expect(r.organic_results.length).toBeGreaterThanOrEqual(8);
    expect(r.related_questions.length).toBeGreaterThan(0);
    expect(r.related_searches.length).toBeGreaterThan(0);
    expect(r.pagination?.next).toBeTruthy();
  });

  it("pizza near me: local pack", () => {
    const html = load("pizza-near-me");
    expect(classify(html, URL_, 200).kind).toBe("serp");
    const r = parseSerp(html, "en");
    expect(r.local_results.length).toBe(3);
    expect(r.local_results[0]!.title).toBeTruthy();
    expect(r.organic_results.length).toBeGreaterThanOrEqual(7);
  });

  it("hono framework: AI Overview and organic results, no ads", () => {
    const html = load("hono-framework");
    expect(classify(html, URL_, 200).kind).toBe("serp");
    const r = parseSerp(html, "en");
    expect(r.ads.length).toBe(0);
    expect(r.ai_overview?.text).toBeTruthy();
    expect(r.organic_results[0]!.title).toMatch(/hono/i);
    // links are resolved later (ping/goto), so only the displayed link is in the raw page
    expect(r.organic_results[0]!.displayed_link).toMatch(/^https:\/\/hono\.dev/);
  });
});
