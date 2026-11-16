// The scraping core against a fake Google on 127.0.0.1 (ported from serpmaven's tests/fakegoogle.py).
// The browser and HTTP layers are small fakes; no real browser or live Google is used.
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type BrowserSide, CURL_BIN, CurlHttp, type Fetched, foldCookies, type Headers, Hybrid, type HttpSide, parseCurlOutput, type PhaseMs, replayHeaders } from "../src/scraper/hybrid.js";
import type { Identity } from "../src/scraper/identity.js";
import { createScraper, resultsUrl, Scraper, uule } from "../src/scraper/index.js";
import { ProxyTemplate, redact } from "../src/scraper/proxy.js";
import type { SearchParams } from "../src/types.js";
import { GOTO_B, NO_JS_PAGE, resultsPage, SORRY_PAGE } from "./fixtures/pages.js";

// -- fake Google ---------------------------------------------------------------
// Exits are named by an `x-exit` header. `/search` serves the JS check until the cookie `ok=1`
// (set by the fake browser "running" the check), then a SERP with a fresh NID.
const fake = {
  refused: new Set<string>(), // 302 to /sorry/
  tooMany: new Set<string>(), // 429
  blank: new Set<string>(), // a page that is neither a SERP nor a known refusal
  slow: new Set<string>(), // answers the browser after 300 ms
  httpCheck: false, // the HTTP side always gets the JS check
  gotoSorry: false, // /goto lookups are refused
  seen: [] as { via: string; exit: string; cookie: string }[],
  lookups: [] as { path: string; via: string; referer: string; site: string; cookie: string }[],
};
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const u = new URL(req.url!, base);
    const exit = String(req.headers["x-exit"] ?? "");
    const cookie = String(req.headers.cookie ?? "");
    const via = String(req.headers["x-via"] ?? "");
    const send = (status: number, body: string, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    if (u.pathname === "/echo") {
      res.writeHead(200, { "content-encoding": "gzip", "set-cookie": ["a=1; Path=/", "b=2; Path=/"] });
      return res.end(gzipSync(JSON.stringify(req.rawHeaders)));
    }
    if (u.pathname === "/goto") {
      const site = String(req.headers["sec-fetch-site"] ?? "");
      fake.lookups.push({ path: u.pathname + u.search, via, referer: String(req.headers.referer ?? ""), site, cookie });
      if (fake.gotoSorry) return send(302, "", { location: "/sorry/index?continue=x" });
      return send(302, "", { location: `https://example.org/${u.searchParams.get("url")}` });
    }
    if (u.pathname === "/redirect") return send(302, "", { location: "/sorry/index?continue=x" });
    if (u.pathname.startsWith("/sorry")) return send(429, SORRY_PAGE);
    if (u.pathname !== "/search") return send(200, "<html><body>home</body></html>");
    fake.seen.push({ via, exit, cookie });
    if (fake.slow.has(exit) && via === "browser") await new Promise((r) => setTimeout(r, 300));
    if (fake.tooMany.has(exit)) return send(429, SORRY_PAGE);
    if (fake.refused.has(exit)) return send(302, "", { location: "/sorry/index?continue=x" });
    if (fake.blank.has(exit)) return send(200, "<html><body>nothing here</body></html>");
    if (via === "http" && fake.httpCheck) return send(200, NO_JS_PAGE);
    if (!/(^|; )ok=1/.test(cookie)) return send(200, NO_JS_PAGE);
    send(200, resultsPage(), { "set-cookie": [`NID=${fake.seen.length}; Path=/`] });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  for (const s of [fake.refused, fake.tooMany, fake.blank, fake.slow]) s.clear();
  fake.httpCheck = false;
  fake.gotoSorry = false;
  fake.seen = [];
  fake.lookups = [];
});

// -- fake layers ---------------------------------------------------------------

class FakeHttp implements HttpSide {
  constructor(private readonly exit: string) {}
  async get(url: string, headers: Headers, signal?: AbortSignal) {
    const res = await fetch(url, { headers: [...headers, ["x-exit", this.exit], ["x-via", "http"]], redirect: "manual", signal });
    const loc = res.headers.get("location");
    return { url: loc ? new URL(loc, url).href : url, status: res.status, html: await res.text(), setCookies: res.headers.getSetCookie() };
  }
}

/** A browser that passes the JS check by setting `ok=1`, as the check's script would. */
class FakeBrowser implements BrowserSide {
  headers: Headers | null = [["user-agent", "FakeChrome/152"], ["accept", "text/html"], ["cookie", "stale"]];
  jar = "";
  searches = 0;
  constructor(private readonly exit: string) {}
  async search(url: string): Promise<Fetched> {
    this.searches++;
    for (let pass = 0; ; pass++) {
      const res = await fetch(url, { headers: { cookie: this.jar, "x-exit": this.exit, "x-via": "browser" } });
      this.jar = foldCookies(this.jar, res.headers.getSetCookie());
      const html = await res.text();
      if (html !== NO_JS_PAGE || pass) return { url: res.url, status: res.status, html };
      this.jar = foldCookies(this.jar, ["ok=1"]);
    }
  }
  async cookies() {
    return this.jar;
  }
  async setCookies(header: string) {
    this.jar = header;
  }
}

const params = (q = "swimming", page = 1): SearchParams => ({ q, page, hl: "en" });

/** Identities whose exits are taken from `exits` in order; the last one repeats. */
function pool(exits: string[]) {
  const made: { id: Identity; closed: boolean; browser: FakeBrowser; restarts: number }[] = [];
  let n = 0;
  const makeIdentity = async () => {
    const exit = exits[Math.min(n, exits.length - 1)]!;
    const browser = new FakeBrowser(exit);
    const hybrid = new Hybrid(browser, new FakeHttp(exit));
    const entry = {
      closed: false,
      browser,
      restarts: 0,
      id: {
        session: `${exit}-${n++}`,
        proxyHost: "gate.example:8080",
        fetch: (u: string, s?: AbortSignal, ms?: PhaseMs) => hybrid.fetch(u, s, ms),
        lookup: (u: string, s?: AbortSignal) => hybrid.lookup(u, s),
        close: async () => void (entry.closed = true),
        get browserPages() {
          return browser.searches;
        },
        restart: async () => {
          browser.searches = 0;
          entry.restarts++;
        },
      },
    };
    made.push(entry);
    return entry.id;
  };
  return { made, makeIdentity };
}

async function ready(s: Scraper) {
  while (s.health().state === "warming") await new Promise((r) => setTimeout(r, 1));
}

// -- hybrid --------------------------------------------------------------------

describe("hybrid", () => {
  it("runs the browser on the JS check, then carries on over HTTP with its cookies", async () => {
    const browser = new FakeBrowser("e");
    const h = new Hybrid(browser, new FakeHttp("e"));
    const first = await h.fetch(resultsUrl(base, params()));
    expect(first).toMatchObject({ via: "browser", verdict: { kind: "serp" } });
    const second = await h.fetch(resultsUrl(base, params("q2")));
    expect(second).toMatchObject({ via: "http", verdict: { kind: "serp" } });
    expect(browser.searches).toBe(1);
    const http = fake.seen.filter((s) => s.via === "http");
    expect(http[0]!.cookie).toBe(""); // the first HTTP try had no cookie yet: the stale one is not replayed
    expect(http[1]!.cookie).toMatch(/ok=1/);
    // The NID the HTTP side received is folded in and sent on the next request.
    await h.fetch(resultsUrl(base, params("q3")));
    expect(fake.seen.at(-1)!.cookie).toContain(`NID=${fake.seen.length - 1}`);
  });

  it("stays on the browser after N non-serp HTTP pages in a row", async () => {
    fake.httpCheck = true;
    const browser = new FakeBrowser("e");
    const h = new Hybrid(browser, new FakeHttp("e"), 2);
    for (let i = 0; i < 3; i++) expect((await h.fetch(resultsUrl(base, params(`q${i}`)))).via).toBe("browser");
    expect(h.browserOnly).toBe(true);
    expect(fake.seen.filter((s) => s.via === "http")).toHaveLength(2);
  });

  it("replays the browser's headers with the current cookie in place", () => {
    expect(replayHeaders([[":method", "GET"], ["user-agent", "U"], ["cookie", "old"], ["accept", "A"]], "c=1")).toEqual([
      ["user-agent", "U"],
      ["cookie", "c=1"],
      ["accept", "A"],
    ]);
    expect(replayHeaders([["user-agent", "U"]], "c=1")).toEqual([["user-agent", "U"], ["cookie", "c=1"]]);
  });

  it("folds Set-Cookie headers, dropping expired ones", () => {
    expect(foldCookies("a=1; b=2", ["b=3; Path=/", "c=4", "a=; Max-Age=0"])).toBe("b=3; c=4");
    expect(foldCookies("a=1", ["a=x; expires=Thu, 01 Jan 1970 00:00:00 GMT"])).toBe("");
  });

  it("parses curl output past an interim response", () => {
    const out = Buffer.from("HTTP/1.1 100 Continue\r\n\r\nHTTP/2 302\r\nset-cookie: a=1\r\nSet-Cookie: b=2\r\nlocation: /sorry/x\r\n\r\nbody");
    expect(parseCurlOutput(out, "https://www.google.com/search?q=x")).toEqual({
      url: "https://www.google.com/sorry/x",
      status: 302,
      html: "body",
      setCookies: ["a=1", "b=2"],
    });
  });
});

describe.skipIf(!existsSync(CURL_BIN))("curl-impersonate client (needs npm run setup)", () => {
  it("sends exactly our headers in our order and returns every Set-Cookie", async () => {
    const headers: Headers = [
      ["sec-ch-ua", '"Chromium";v="156", "Not:A-Brand";v="99"'],
      ["user-agent", "U\\x"],
      ["accept-encoding", "gzip, deflate, br, zstd"],
      ["cookie", "a=1; b=2"],
    ];
    const r = await new CurlHttp(null).get(`${base}/echo`, headers);
    const sent: string[] = JSON.parse(r.html);
    const names = sent.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
    expect(names.slice(0, 4)).toEqual(headers.map(([n]) => n));
    expect(sent[1]).toBe(headers[0]![1]);
    expect(sent[3]).toBe("U\\x");
    expect(r.setCookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    const sorry = await new CurlHttp(null).get(`${base}/redirect`, []);
    expect(sorry).toMatchObject({ status: 302, url: `${base}/sorry/index?continue=x` });
  });
});

// -- scraper -------------------------------------------------------------------

describe("Scraper", () => {
  it("rotates past refused exits and records the exit that served", async () => {
    fake.refused.add("bad");
    fake.tooMany.add("busy");
    const p = pool(["bad", "busy", "good"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
    const r = await s.search(params());
    expect(r.search_metadata.status).toBe("Success");
    expect(r.search_metadata.page_verdict).toBe("serp");
    expect(r.exit).toEqual({ session: "good-2", proxy_host: "gate.example:8080" });
    expect(r.organic_results).toHaveLength(3);
    expect(r.goto_links).toBeUndefined();
    expect(p.made.map((m) => m.closed)).toEqual([true, true, false]);
    expect(s.health().state).toBe("ok");
    await s.close();
    expect(p.made[2]!.closed).toBe(true);
  });

  it("gives up after three exits with an Error record carrying the verdict", async () => {
    fake.refused.add("bad");
    const p = pool(["bad"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
    const r = await s.search(params());
    expect(r.search_metadata).toMatchObject({ status: "Error", page_verdict: "sorry", google_url: null });
    expect(r.error).toMatch(/refused on 3 exits/);
    expect(s.health().state).not.toBe("down");
    await s.close();
  });

  it("returns unknown as an Error record without retiring the exit", async () => {
    fake.blank.add("odd");
    const p = pool(["odd"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
    const r = await s.search(params());
    expect(r.search_metadata).toMatchObject({ status: "Error", page_verdict: "unknown" });
    expect(p.made).toHaveLength(1);
    expect(p.made[0]!.closed).toBe(false);
    await s.close();
  });

  it("goes down after six refused exits in a row", async () => {
    fake.refused.add("bad");
    const p = pool(["bad"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
    await s.search(params("a"));
    await s.search(params("b"));
    expect(s.health().state).toBe("down");
    const r = await s.search(params("c"));
    expect(r.error).toMatch(/scraper is down/);
    await s.close();
  });

  it("goes down when warm-ups keep failing", async () => {
    const s = new Scraper({
      poolSize: 1,
      makeIdentity: async () => {
        throw new Error("launch failed via http://user:secret@gate:1");
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    const h = s.health();
    expect(h.state).toBe("down");
    expect(String(h.reason)).not.toContain("secret");
    await s.close();
  });

  it("stops waiting on abort and keeps the identity usable", async () => {
    fake.slow.add("slow");
    const p = pool(["slow"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
    await ready(s);
    const ac = new AbortController();
    const started = performance.now();
    const pending = s.search(params(), ac.signal);
    setTimeout(() => ac.abort(new Error("timeout")), 30);
    await expect(pending).rejects.toThrow("timeout");
    expect(performance.now() - started).toBeLessThan(250);
    expect(s.health().state).toBe("busy"); // the browser's page is still loading
    const r = await s.search(params("again"));
    expect(r.search_metadata.status).toBe("Success");
    expect(p.made).toHaveLength(1);
    expect(p.made[0]!.closed).toBe(false);
    await s.close();
  });

  it("resolves links without one over the identity's HTTP client, as a click would", async () => {
    const p = pool(["good"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
    const r = await s.search(params());
    const links = (r.organic_results as { link: string | null }[]).map((o) => o.link);
    expect(links[0]).toMatch(/^https:\/\/www\.usms\.org\//); // from the inline JSON, not looked up
    expect(links[2]).toBe(`https://example.org/${GOTO_B}`);
    expect(fake.lookups).toEqual([{ path: `/goto?url=${GOTO_B}`, via: "http", referer: `${base}/`, site: "same-origin", cookie: expect.stringMatching(/ok=1/) }]);
    expect(r.ping_paths).toBeUndefined();
    await s.close();
  });

  it("leaves links alone with links=0", async () => {
    const p = pool(["good"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
    const r = await s.search({ ...params(), links: 0 });
    expect((r.organic_results as { link: string | null }[])[2]!.link).toBeNull();
    expect(fake.lookups).toEqual([]);
    await s.close();
  });

  it("leaves links alone with links_wait=0", async () => {
    const p = pool(["good"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
    const r = await s.search({ ...params(), links_wait: 0 });
    expect((r.organic_results as { link: string | null }[])[2]!.link).toBeNull();
    expect(fake.lookups).toEqual([]);
    expect(r.search_parameters.links_wait).toBe(0);
    await s.close();
  });

  it("keeps the page and the exit when lookups are refused", async () => {
    fake.gotoSorry = true;
    const p = pool(["good"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
    const r = await s.search(params());
    expect(r.search_metadata.status).toBe("Success");
    expect((r.organic_results as { link: string | null }[])[2]!.link).toBeNull();
    expect(p.made).toHaveLength(1);
    expect(p.made[0]!.closed).toBe(false);
    await s.close();
  });

  it("saves each fetched page under SAVE_HTML, readable by the owner only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openserp-html-"));
    process.env.SAVE_HTML = dir;
    try {
      const p = pool(["good"]);
      const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
      await s.search(params("Swim Fast!", 2));
      await s.close();
      let files: string[] = [];
      for (let i = 0; i < 100 && !files.length; i++) files = (await new Promise((r) => setTimeout(r, 5)), readdirSync(dir));
      expect(files.every((f) => /^\d{4}-.*-swim-fast-p2\.html$/.test(f))).toBe(true);
      expect(files.length).toBeGreaterThan(0);
      expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    } finally {
      delete process.env.SAVE_HTML;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restarts the browser between queries after BROWSER_MAX_PAGES browser pages, keeping the exit", async () => {
    fake.httpCheck = true; // every query runs on the browser
    const p = pool(["good"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0], browserMaxPages: 2, settleMs: [0, 0] });
    for (const q of ["a", "b", "c"]) expect((await s.search(params(q))).search_metadata.status).toBe("Success");
    expect(p.made).toHaveLength(1);
    expect(p.made[0]).toMatchObject({ restarts: 1, closed: false });
    await s.close();
    const never = pool(["good"]);
    const s0 = new Scraper({ poolSize: 1, makeIdentity: never.makeIdentity, origin: base, gapMs: [0, 0], browserMaxPages: 0, settleMs: [0, 0] });
    for (const q of ["a", "b", "c"]) await s0.search(params(q));
    expect(never.made[0]!.restarts).toBe(0);
    await s0.close();
  });

  it("takes a new exit after EXIT_MAX_QUERIES queries without tripping the breaker", async () => {
    const p = pool(["one", "two"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0], exitMaxQueries: 2 });
    const sessions: unknown[] = [];
    for (const q of ["a", "b", "c"]) sessions.push((await s.search(params(q))).exit?.session);
    expect(sessions).toEqual(["one-0", "one-0", "two-1"]);
    expect(p.made[0]!.closed).toBe(true);
    expect(s.health().state).toBe("ok");
    await s.close();
  });

  it("drops an exit whose pages keep answering other queries", async () => {
    const p = pool(["poisoned", "fresh"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
    // The fixture's titles are about swimming: unrelated to these queries.
    const first = await s.search(params("cheap flights rome"));
    expect(first.search_metadata.status).toBe("Success"); // one odd page is not enough
    await s.search(params("pizza delivery downtown"));
    const third = await s.search(params("mortgage rates today"));
    expect(p.made[0]!.closed).toBe(true);
    expect(third.exit).toMatchObject({ session: "fresh-1" });
    await s.close();
  });

  it("never drops an exit for related, short or non-Latin queries", async () => {
    const p = pool(["good"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
    for (const q of ["swimming for beginners", "swimming", "水泳 初心者 練習", "yüzme dersi fiyatları", '"swim lessons" cheap', "beginner swimming guide", "水泳"]) {
      expect((await s.search(params(q))).search_metadata.status, q).toBe("Success");
    }
    expect(p.made).toHaveLength(1);
    expect(p.made[0]!.closed).toBe(false);
    await s.close();
  });

  it("records where the page's time went, only for the phases that happened", async () => {
    fake.refused.add("bad");
    const p = pool(["bad", "good"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
    const first = (await s.search(params())).search_metadata.timings!;
    // Each exit tries HTTP first, then the browser; "bad" is sent to /sorry, "good" serves and resolves links.
    expect(first).toMatchObject({ exits: 2, retries: ["sorry"], links_lookups: 1, links_held: 0 });
    for (const k of ["queue", "fetch", "browser", "links", "total"] as const) expect(Number.isInteger(first[k]), k).toBe(true);
    const second = (await s.search({ ...params("q2"), links: 0 })).search_metadata.timings!;
    expect(Object.keys(second).sort()).toEqual(["exits", "fetch", "queue", "total"]); // served over HTTP, no links, no retries
    expect(second.exits).toBe(1);
    expect(second.total).toBeGreaterThanOrEqual(second.fetch!);
    await s.close();
  });

  it("gives links_wait as the page's link budget, even above the env budget", async () => {
    const p = pool(["good"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0], linkBudgetMs: 1, linkParallel: 1 });
    const r = await s.search({ ...params(), links_wait: 10 });
    expect((r.organic_results as { link: string | null }[])[2]!.link).toBe(`https://example.org/${GOTO_B}`);
    await s.close();
  });

  it("logs a browser restart and an exit-cap retirement with why and how long", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fake.httpCheck = true;
      const p = pool(["one", "two"]);
      const s = new Scraper({ poolSize: 1, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0], browserMaxPages: 1, exitMaxQueries: 2, settleMs: [0, 0] });
      for (const q of ["a", "b", "c"]) await s.search(params(q));
      await s.close();
      const lines = err.mock.calls.map((c) => String(c[0]));
      expect(lines).toContainEqual(expect.stringMatching(/^browser restart on one-0 after 1 pages \(BROWSER_MAX_PAGES\): \d+\.\ds, settling 0\.0s$/));
      expect(lines).toContainEqual(expect.stringMatching(/^identity one-0 retired after 2 queries \(EXIT_MAX_QUERIES\): new identity two-1 ready in \d+\.\ds$/));
    } finally {
      err.mockRestore();
    }
  });

  it("refuses bad LINK_PARALLEL and LINK_BUDGET_MS at startup", () => {
    const env = { SCRAPER_PROXY: "http://gate.example:8080" };
    for (const [k, v] of [["LINK_PARALLEL", "0"], ["LINK_PARALLEL", "two"], ["LINK_BUDGET_MS", "1.5"], ["LINK_BUDGET_MS", "-1"]]) {
      expect(() => createScraper({ ...env, [k!]: v }), `${k}=${v}`).toThrow(new RegExp(`^invalid config: ${k}: `));
    }
  });

  it("reports warming until an identity is ready", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const p = pool(["good"]);
    const s = new Scraper({ poolSize: 1, makeIdentity: async () => (await gate, p.makeIdentity()), origin: base, gapMs: [0, 0] });
    expect(s.health().state).toBe("warming");
    finish();
    await ready(s);
    expect(s.health()).toMatchObject({ state: "ok", pool: 1, ready: 1 });
    await s.close();
  });
});

describe("spare identities", () => {
  /** `p.makeIdentity` where the calls numbered in `held` wait for `open()`; the rest go through at once. */
  function gated(p: ReturnType<typeof pool>, held: (call: number) => boolean) {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let calls = 0;
    const makeIdentity = async () => {
      if (held(calls++)) await gate;
      return p.makeIdentity();
    };
    return { makeIdentity, open, calls: () => calls };
  }
  const h = (s: Scraper) => s.health() as { spares?: number; ready?: number };
  const until = async (ok: () => boolean) => {
    while (!ok()) await new Promise((r) => setTimeout(r, 1));
  };

  it("swaps a refused identity for the warmed spare without waiting, then warms a new spare", async () => {
    fake.refused.add("bad");
    const p = pool(["bad", "good"]);
    const g = gated(p, (n) => n >= 2);
    const s = new Scraper({ poolSize: 1, spares: 1, makeIdentity: g.makeIdentity, origin: base, gapMs: [0, 0] });
    await until(() => h(s).spares === 1 && h(s).ready === 1);
    const r = await s.search(params());
    expect(r.search_metadata.status).toBe("Success");
    expect(r.exit).toMatchObject({ session: "good-1" });
    expect(r.search_metadata.timings?.retries).toEqual(["sorry"]);
    expect(g.calls()).toBe(3); // only the new spare, no warm-up in the slot
    expect(s.health()).toMatchObject({ state: "ok", spares: 0 });
    g.open();
    await until(() => h(s).spares === 1);
    expect(p.made.map((m) => m.closed)).toEqual([true, false, false]);
    await s.close();
  });

  it("does not hand out a spare still warming", async () => {
    fake.refused.add("bad");
    const p = pool(["bad", "good"]);
    const g = gated(p, (n) => n === 1); // the first spare
    const s = new Scraper({ poolSize: 1, spares: 1, makeIdentity: g.makeIdentity, origin: base, gapMs: [0, 0] });
    const r = await s.search(params());
    expect(r.exit).toMatchObject({ session: "good-1" }); // warmed in the slot, not the held spare
    expect(h(s).spares).toBe(0);
    expect(g.calls()).toBe(3); // no second spare while one is warming
    g.open();
    await until(() => h(s).spares === 1);
    await s.close();
  });

  it("keeps the old behaviour with spares 0", async () => {
    fake.refused.add("bad");
    const p = pool(["bad", "good"]);
    const s = new Scraper({ poolSize: 1, spares: 0, makeIdentity: p.makeIdentity, origin: base, gapMs: [0, 0] });
    const r = await s.search(params());
    expect(r.exit).toMatchObject({ session: "good-1" });
    expect(p.made).toHaveLength(2);
    expect(s.health()).toMatchObject({ state: "ok", spares: 0 });
    await s.close();
  });

  it("closes spares on close(), including one that finishes warming afterwards", async () => {
    const p = pool(["good"]);
    const g = gated(p, (n) => n === 2);
    const s = new Scraper({ poolSize: 1, spares: 2, makeIdentity: g.makeIdentity, origin: base, gapMs: [0, 0] });
    await until(() => h(s).spares === 1);
    const closing = s.close();
    g.open();
    await closing;
    expect(p.made).toHaveLength(3);
    expect(p.made.every((m) => m.closed)).toBe(true);
  });

  it("refuses a bad SPARE_IDENTITIES at startup", () => {
    for (const v of ["-1", "1.5", "one"]) {
      expect(() => createScraper({ SCRAPER_PROXY: "http://gate.example:8080", SPARE_IDENTITIES: v }), v).toThrow(/^invalid config: SPARE_IDENTITIES: /);
    }
  });
});

// A real headful patchright Chromium against the fake Google; opens a window.
describe.skipIf(!process.env.RUN_BROWSER_TESTS)("real browser (RUN_BROWSER_TESTS=1)", () => {
  it("captures headers, searches and shares cookies", async () => {
    const { Browser } = await import("../src/scraper/browser.js");
    const b = await Browser.open(null, base);
    try {
      expect(await b.home()).toBe(true);
      expect(b.headers!.find(([n]) => n === "user-agent")?.[1]).toMatch(/Chrome\/\d+/);
      expect(b.headers!.some(([n]) => n.startsWith(":"))).toBe(false);
      expect((await b.search(`${base}/search?q=x`)).html).toContain("enablejs");
      await b.setCookies("ok=1");
      const served = await b.search(`${base}/search?q=x`);
      expect(served.html).toContain('id="rso"');
      expect(await b.cookies()).toMatch(/ok=1.*NID=|NID=.*ok=1/);
      // A restart keeps the jar, session cookies included, and the captured headers.
      await b.restart();
      expect(await b.cookies()).toMatch(/ok=1.*NID=|NID=.*ok=1/);
      expect(b.headers).not.toBeNull();
      expect((await b.search(`${base}/search?q=x`)).html).toContain('id="rso"');
    } finally {
      await b.close();
    }
  }, 60_000);
});

// -- urls and proxy ------------------------------------------------------------

describe("results URL", () => {
  it("carries page, filters and a uule", () => {
    const url = resultsUrl("https://www.google.com", { q: "a b", page: 2, hl: "en", gl: "us", tbs: "qdr:w", location: "Austin,Texas,United States" });
    expect(url).toBe(`https://www.google.com/search?q=a+b&hl=en&gl=us&tbs=qdr%3Aw&start=10&uule=${uule("Austin,Texas,United States")}`);
    expect(uule("Austin,Texas,United States")).toBe("w+CAIQICIaQXVzdGluLFRleGFzLFVuaXRlZCBTdGF0ZXM");
  });
});

describe("proxy", () => {
  it("redacts credentials", () => {
    expect(redact("connect http://user-sid-1:p%40ss@gate.example:8080 failed")).toBe("connect http://***@gate.example:8080 failed");
    expect(redact("socks5://u:p@h:1 and https://a:b@c:2/x")).toBe("socks5://***@h:1 and https://***@c:2/x");
    expect(redact("no url here")).toBe("no url here");
  });

  it("gives each session its own sticky username", () => {
    const t = new ProxyTemplate("http://user-sid-{session}:p%40ss@gate.nodemaven.com:8080");
    expect(t.sticky).toBe(true);
    expect(t.forSession("abc123")).toEqual({
      server: "http://gate.nodemaven.com:8080",
      username: "user-sid-abc123",
      password: "p@ss",
      session: "abc123",
      host: "gate.nodemaven.com:8080",
    });
    expect(t.describe()).not.toContain("p@ss");
  });

  it("shares one URL without a placeholder", () => {
    const t = new ProxyTemplate("http://u:p@gate:8080");
    expect(t.sticky).toBe(false);
    expect(t.forSession("x").username).toBe("u");
    expect(t.forSession("y").username).toBe("u");
  });

  it("rejects SOCKS5 with auth and malformed URLs, without echoing the password", () => {
    expect(() => new ProxyTemplate("socks5://u:p@gate:1080")).toThrow(/SOCKS5/);
    expect(() => new ProxyTemplate("socks5://gate:1080")).not.toThrow();
    expect(() => new ProxyTemplate("ftp://u:p@gate:21")).toThrow(/scheme/);
    expect(() => new ProxyTemplate("http://gate")).toThrow(/port/);
    expect(() => new ProxyTemplate("not a url secret")).toThrow();
  });
});

describe("auto location from gl", async () => {
  const { countryName } = await import("../src/scraper/index.js");
  it("pins the local pack to the gl country when no location is given", () => {
    expect(countryName("us")).toBe("United States");
    expect(countryName("zz")).toBeUndefined();
    const p = { q: "pizza", page: 1, hl: "en" };
    expect(resultsUrl("https://www.google.com", { ...p, gl: "us" })).toContain(`&uule=${uule("United States")}`);
    expect(resultsUrl("https://www.google.com", { ...p, gl: "us", location: "Austin,Texas,United States" })).toContain(`&uule=${uule("Austin,Texas,United States")}`);
    expect(resultsUrl("https://www.google.com", p)).not.toContain("uule");
  });
});
