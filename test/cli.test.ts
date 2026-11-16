import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { type Deps, main, parseSearchArgs, UsageError } from "../src/cli/index.js";
import { answered, openWriter } from "../src/cli/output.js";
import type { SearchParams, SerpRecord } from "../src/types.js";

const tmp = () => mkdtempSync(join(tmpdir(), "cli-test-"));

function rec(q: string, page = 1, ok = true, next = false, extra: Record<string, unknown> = {}): SerpRecord {
  return {
    search_metadata: {
      id: "x",
      status: ok ? "Success" : "Error",
      created_at: "2026-01-01T00:00:00Z",
      total_time_taken: 0,
      google_url: null,
      page_verdict: null,
      verdict_reason: null,
    },
    search_parameters: { q, page, hl: "en", engine: "google", device: "desktop" },
    organic_results: ok ? [{ position: 1, title: `t, "${q}"`, link: "https://a.example", snippet: "s\nx" }] : [],
    pagination: next ? { next: "https://www.google.com/search?start=10" } : {},
    ...extra,
  };
}

const lines = (rs: SerpRecord[]) => rs.map((r) => `${JSON.stringify(r)}\n`).join("");

describe("writers", () => {
  it("jsonl writes a line per record as it arrives", () => {
    let out = "";
    const w = openWriter("jsonl", (s) => (out += s));
    w.write(rec("a"));
    expect(out.split("\n")).toHaveLength(2);
    w.close();
    expect(JSON.parse(out.trim()).search_parameters.q).toBe("a");
  });

  it("json writes one array on close", () => {
    let out = "";
    const w = openWriter("json", (s) => (out += s));
    w.write(rec("a"));
    w.write(rec("b"));
    expect(out).toBe("");
    w.close();
    expect(JSON.parse(out).map((r: SerpRecord) => r.search_parameters.q)).toEqual(["a", "b"]);
  });

  it("csv writes organic rows with quoting, nothing for failed pages", () => {
    let out = "";
    const w = openWriter("csv", (s) => (out += s));
    w.write(rec("a"));
    w.write(rec("b", 1, false));
    expect(out).toBe(
      'query,page,position,title,link,displayed_link,source,date,snippet\r\na,1,1,"t, ""a""",https://a.example,,,,"s\nx"\r\n',
    );
  });
});

describe("answered", () => {
  it("keeps served queries and cuts a half-written last line", () => {
    const f = join(tmp(), "o.jsonl");
    const body = lines([rec("done"), rec("failed", 1, false), rec("retried", 1, false), rec("retried")]);
    writeFileSync(f, `${body}{"search_par`);
    expect(answered(f)).toEqual(new Set(["done", "retried"]));
    expect(readFileSync(f, "utf8")).toBe(body);
  });

  it("with several pages a query cut short is asked again, one without a next page is not", () => {
    const f = join(tmp(), "o.jsonl");
    writeFileSync(f, lines([rec("short", 1, true, true), rec("end", 1, true, false), rec("full", 1, true, true), rec("full", 2, true, true)]));
    expect(answered(f, 2)).toEqual(new Set(["end", "full"]));
  });

  it("a failed later page makes the query incomplete", () => {
    const f = join(tmp(), "o.jsonl");
    writeFileSync(f, lines([rec("a", 1, true, true), rec("a", 2, false)]));
    expect(answered(f, 2)).toEqual(new Set());
  });

  it("counts only records made with the same parameters, skips bad pages", () => {
    const f = join(tmp(), "o.jsonl");
    const de = rec("de");
    de.search_parameters.gl = "de";
    const bad = rec("bad");
    (bad.search_parameters as { page: unknown }).page = "1";
    writeFileSync(f, `${lines([rec("us"), de, bad])}not json\n`);
    expect(answered(f, 1, { hl: "en", gl: "de" })).toEqual(new Set(["de"]));
    expect(answered(f, 1, { hl: "en" })).toEqual(new Set(["us"]));
  });

  it("a missing file answers nothing", () => {
    expect(answered(join(tmp(), "none.jsonl"))).toEqual(new Set());
  });
});

describe("parseSearchArgs", () => {
  it("defaults", () => {
    expect(parseSearchArgs(["a b", "c"])).toMatchObject({ queries: ["a b", "c"], pages: 1, hl: "en", format: "jsonl", resume: false });
  });

  it("flags", () => {
    expect(
      parseSearchArgs(["q", "--pages", "3", "--hl", "de", "--gl", "de", "--location", "Berlin", "--links", "0", "--format", "csv", "--output", "o.csv"]),
    ).toMatchObject({ pages: 3, hl: "de", gl: "de", location: "Berlin", links: 0, format: "csv", output: "o.csv" });
  });

  it.each([
    [["--pages", "0"]],
    [["--pages", "x"]],
    [["--links", "-1"]],
    [["--links-wait", "-1"]],
    [["--links-wait", "121"]],
    [["--links-wait", "x"]],
    [["--links-wait", ""]],
    [["--format", "xml"]],
    [["--resume"]],
    [["--resume", "--output", "o.csv", "--format", "csv"]],
    [["--nope"]],
    [["--hl", "english"]],
    [["--gl", "usa"]],
  ])("refuses %j", (args) => {
    expect(() => parseSearchArgs(args)).toThrow(UsageError);
  });

  it("reads --links-wait in seconds under the API's rule and message", () => {
    expect(parseSearchArgs(["q", "--links-wait", "2.5"]).links_wait).toBe(2.5);
    expect(parseSearchArgs(["q", "--links-wait", "0"]).links_wait).toBe(0);
    expect(parseSearchArgs(["q"]).links_wait).toBeUndefined();
    expect(() => parseSearchArgs(["q", "--links-wait", "121"])).toThrow("links_wait must be between 0 and 120");
  });

  it("gives hl/gl errors the API's messages and DEFAULT_* fills them in", () => {
    expect(() => parseSearchArgs(["q", "--gl", "usa"])).toThrow("gl must be a two-letter country code such as us");
    expect(() => parseSearchArgs(["q", "--hl", "x"])).toThrow("hl must be a language code such as en or pt-BR");
    expect(parseSearchArgs(["q"])).toMatchObject({ hl: "en", gl: "us" });
    expect(parseSearchArgs(["q"], { DEFAULT_GL: "", DEFAULT_HL: "de" })).toMatchObject({ hl: "de", gl: undefined });
    expect(() => parseSearchArgs(["q"], { DEFAULT_GL: "usa" })).toThrow(UsageError);
  });
});

/** Answers `pagesPerQuery` pages per query, fails queries starting with "fail". */
function fakeDeps(opts: { stdin?: string; env?: NodeJS.ProcessEnv; pagesPerQuery?: number; signal?: AbortSignal } = {}) {
  const calls: SearchParams[] = [];
  let out = "";
  let err = "";
  let closed = false;
  const deps: Deps = {
    env: opts.env ?? {},
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    stdin: opts.stdin === undefined ? undefined : Object.assign(Readable.from([opts.stdin]), { isTTY: false }),
    signal: opts.signal,
    startRuntime: async () => ({
      live: true,
      close: async () => void (closed = true),
      searcher: {
        health: () => ({ state: "ok" as const }),
        async search(p) {
          calls.push(p);
          await new Promise((r) => setTimeout(r, 1));
          return rec(p.q, p.page, !p.q.startsWith("fail"), p.page < (opts.pagesPerQuery ?? 1));
        },
      },
    }),
  };
  return { deps, calls, out: () => out, err: () => err, closed: () => closed };
}

describe("main", () => {
  it("search writes one record per page, stops when there is no next page", async () => {
    const t = fakeDeps({ pagesPerQuery: 2 });
    expect(await main(["search", "a", "b", "--pages", "3", "--hl", "de"], t.deps)).toBe(0);
    const out = t.out().trim().split("\n").map((l) => JSON.parse(l));
    expect(out.map((r) => `${r.search_parameters.q}${r.search_parameters.page}`).sort()).toEqual(["a1", "a2", "b1", "b2"]);
    expect(t.calls.every((c) => c.hl === "de")).toBe(true);
    expect(t.err()).toContain('"a" page 2: Success, 1 organic,');
    expect(t.closed()).toBe(true);
  });

  it("reads stdin, runs queries up to POOL_SIZE at once, keeps pages in order per query, exits 1 on failure", async () => {
    const t = fakeDeps({ stdin: "a\n\nfail\nc\n", env: { POOL_SIZE: "3" }, pagesPerQuery: 3 });
    expect(await main(["search", "--pages", "3"], t.deps)).toBe(1);
    const out = t.out().trim().split("\n").map((l) => JSON.parse(l).search_parameters);
    expect(out.filter((p) => p.q === "a").map((p) => p.page)).toEqual([1, 2, 3]);
    expect(out.filter((p) => p.q === "fail").map((p) => p.page)).toEqual([1]);
    expect(out.slice(0, 3).map((p) => p.q).sort()).toEqual(["a", "c", "fail"]);
  });

  it("--resume asks only what the output lacks and appends", async () => {
    const f = join(tmp(), "o.jsonl");
    writeFileSync(f, lines([rec("a"), rec("b", 1, false)]));
    const t = fakeDeps({ env: { DEFAULT_GL: "" } }); // the records carry no gl
    expect(await main(["search", "a", "b", "--output", f, "--resume"], t.deps)).toBe(0);
    expect(t.calls.map((c) => c.q)).toEqual(["b"]);
    expect(readFileSync(f, "utf8").trim().split("\n")).toHaveLength(3);
    expect(t.err()).toContain("resume: 1 of 2 queries");
  });

  it("--input file and csv output", async () => {
    const d = tmp();
    writeFileSync(join(d, "q.txt"), "﻿one\r\ntwo\r\n");
    const t = fakeDeps();
    expect(await main(["search", "--input", join(d, "q.txt"), "--format", "csv", "--output", join(d, "o.csv")], t.deps)).toBe(0);
    expect(readFileSync(join(d, "o.csv"), "utf8").split("\r\n").filter(Boolean)).toHaveLength(3);
  });

  it("an abort stops the run, closes the runtime and flushes the writer", async () => {
    const ac = new AbortController();
    const t = fakeDeps({ signal: ac.signal, pagesPerQuery: 100 });
    const run = main(["search", "a", "--pages", "100", "--format", "json"], t.deps);
    setTimeout(() => ac.abort(), 20);
    expect(await run).toBe(130);
    expect(t.closed()).toBe(true);
    const got = JSON.parse(t.out());
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(100);
  });

  it("usage errors exit 2", async () => {
    const t = fakeDeps();
    expect(await main([], t.deps)).toBe(2);
    expect(await main(["search"], t.deps)).toBe(2);
    expect(await main(["search", "a", "--pages", "0"], t.deps)).toBe(2);
    expect(await main(["search", "a", "--gl", "usa"], t.deps)).toBe(2);
    expect(t.err()).toContain("usage:");
  });

  it("doctor prints names, never values", async () => {
    const t = fakeDeps({ env: { CF_API_TOKEN: "very-secret-value", SCRAPER_PROXY: "http://u:p@h:1" } });
    await main(["doctor"], t.deps);
    expect(t.out()).toContain("✓ CF_API_TOKEN is set");
    expect(t.out()).toContain("✗ CF_ACCOUNT_ID is not set");
    expect(t.out()).not.toContain("very-secret-value");
    expect(t.out()).not.toContain("u:p@h");
  });
});
