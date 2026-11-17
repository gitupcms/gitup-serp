import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { CachingSearcher } from "../src/scraper/cache.js";
import type { ExtractFn } from "../src/extract/attach.js";
import type { Extracted } from "../src/extract/index.js";
import { createApp, querySchema } from "../src/server/app.js";
import type { SearchParams, Searcher, SerpRecord } from "../src/types.js";

const KEY = "secret-key";
const base: Config = {
  PORT: 0,
  HOST: "127.0.0.1",
  OPENSERP_API_KEY: KEY,
  MAX_PAGES: 3,
  MAX_CONCURRENCY: 1,
  MAX_QUEUE: 1,
  REQUEST_TIMEOUT_MS: 1000,
  RATE_PER_MIN: 1000,
  DEFAULT_HL: "en",
  DEFAULT_GL: "us",
  TRUST_PROXY: false,
  EXTRACT_PARALLEL: 3,
};
const auth = { Authorization: `Bearer ${KEY}` };

function record(p: SearchParams): SerpRecord {
  return {
    search_metadata: {
      id: "x",
      status: "Success",
      created_at: new Date().toISOString(),
      total_time_taken: 0,
      google_url: null,
      page_verdict: "serp",
      verdict_reason: null,
    },
    search_parameters: { ...p, engine: "google", device: "desktop" },
  };
}

class Fake implements Searcher {
  calls: SearchParams[] = [];
  constructor(
    private delay = 0,
    private state: "ok" | "down" = "ok",
  ) {}
  async search(p: SearchParams, signal?: AbortSignal) {
    this.calls.push(p);
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    signal?.throwIfAborted();
    return record(p);
  }
  health() {
    return { state: this.state };
  }
}

const make = (s: Searcher = new Fake(), cfg: Partial<Config> = {}) =>
  createApp(s, { ...base, ...cfg }, () => {});

describe("auth", () => {
  it("accepts the right bearer key", async () => {
    const res = await make().request("/search.json?q=shoes", { headers: auth });
    expect(res.status).toBe(200);
  });
  it("rejects a missing or wrong key", async () => {
    expect((await make().request("/search.json?q=shoes")).status).toBe(401);
    const res = await make().request("/search.json?q=shoes", { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });
  it("refuses a key in the query string", async () => {
    const res = await make().request(`/search.json?q=shoes&api_key=${KEY}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "use Authorization header" });
  });
  it("needs no key when none is configured", async () => {
    const res = await make(new Fake(), { OPENSERP_API_KEY: undefined }).request("/search?q=shoes");
    expect(res.status).toBe(200);
  });
});

describe("validation", () => {
  it.each([
    ["/search.json", "q is required"],
    ["/search.json?q=a&pages=4", "pages must be between 1 and 3"],
    ["/search.json?q=a&pages=x", "pages must be an integer"],
    ["/search.json?q=a&gl=usa", "gl must be a two-letter country code such as us"],
    ["/search.json?q=a&hl=english", "hl must be a language code such as en or pt-BR"],
    ["/search.json?q=a&links_wait=x", "links_wait must be a number"],
    ["/search.json?q=a&links_wait=-1", "links_wait must be between 0 and 120"],
    ["/search.json?q=a&links_wait=121", "links_wait must be between 0 and 120"],
  ])("%s -> 400", async (url, error) => {
    const res = await make().request(url, { headers: auth });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  it("passes links_wait on in seconds, 0 included", async () => {
    const fake = new Fake();
    await make(fake).request("/search.json?q=a&links_wait=2.5", { headers: auth });
    await make(fake).request("/search.json?q=a&links_wait=0", { headers: auth });
    await make(fake).request("/search.json?q=a", { headers: auth });
    expect(fake.calls.map((c) => c.links_wait)).toEqual([2.5, 0, undefined]);
  });
});

describe("pages", () => {
  it("returns one record for one page", async () => {
    const fake = new Fake();
    const body = await (await make(fake).request("/search.json?q=a&gl=us", { headers: auth })).json();
    expect(Array.isArray(body)).toBe(false);
    expect(body.search_parameters).toMatchObject({ q: "a", hl: "en", gl: "us", page: 1 });
  });
  it("returns an array for more pages, each page under its own id", async () => {
    const fake = new Fake();
    const app = make(fake);
    const body = await (await app.request("/search.json?q=a&pages=2", { headers: auth })).json();
    expect(body).toHaveLength(2);
    expect(fake.calls.map((c) => c.page)).toEqual([1, 2]);
    const [a, b] = body.map((r: SerpRecord) => r.search_metadata.id);
    expect(a).not.toBe(b);
    for (const [i, id] of [a, b].entries()) {
      const one = await (await app.request(`/searches/${id}.json`, { headers: auth })).json();
      expect(one.search_parameters.page).toBe(i + 1);
    }
  });
  it("keeps the combined pages under the async request id", async () => {
    const app = make(new Fake());
    const first = await (await app.request("/search.json?q=a&pages=2&async=true", { headers: auth })).json();
    const id = first.search_metadata.id as string;
    await new Promise((r) => setTimeout(r, 20));
    const all = await (await app.request(`/searches/${id}.json`, { headers: auth })).json();
    expect(all).toHaveLength(2);
    expect(all.map((r: SerpRecord) => r.search_metadata.id)).not.toContain(id);
  });
});

describe("default gl/hl", () => {
  it("fills in DEFAULT_GL and DEFAULT_HL", async () => {
    const fake = new Fake();
    await make(fake, { DEFAULT_GL: "de", DEFAULT_HL: "de" }).request("/search.json?q=a", { headers: auth });
    expect(fake.calls[0]).toMatchObject({ gl: "de", hl: "de" });
  });
  it("lets the caller override them, and sends no gl when DEFAULT_GL is off", async () => {
    const fake = new Fake();
    const app = make(fake, { DEFAULT_GL: undefined });
    await app.request("/search.json?q=a&gl=fr&hl=fr", { headers: auth });
    await app.request("/search.json?q=a", { headers: auth });
    expect(fake.calls[0]).toMatchObject({ gl: "fr", hl: "fr" });
    expect(fake.calls[1]!.gl).toBeUndefined();
  });
});

describe("async", () => {
  it("answers Processing, then the record by id", async () => {
    const app = make(new Fake(30));
    const first = await (await app.request("/search.json?q=a&async=true", { headers: auth })).json();
    expect(first.search_metadata.status).toBe("Processing");
    const id = first.search_metadata.id as string;
    const again = await (await app.request(`/searches/${id}.json`, { headers: auth })).json();
    expect(again.search_metadata.status).toBe("Processing");
    await new Promise((r) => setTimeout(r, 60));
    const done = await (await app.request(`/searches/${id}.json`, { headers: auth })).json();
    expect(done.search_metadata).toMatchObject({ id, status: "Success" });
  });
  it("404s an unknown id", async () => {
    const res = await make().request(`/searches/${"0".repeat(32)}.json`, { headers: auth });
    expect(res.status).toBe(404);
  });
});

describe("queue", () => {
  it("answers 429 when running and waiting slots are full", async () => {
    const app = make(new Fake(100));
    const a = app.request("/search.json?q=a", { headers: auth }); // runs
    const b = app.request("/search.json?q=b", { headers: auth }); // waits
    const c = await app.request("/search.json?q=c", { headers: auth });
    expect(c.status).toBe(429);
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
  });
  it("answers 504 when the job outlives its deadline", async () => {
    const res = await make(new Fake(200), { REQUEST_TIMEOUT_MS: 50 }).request("/search.json?q=a", {
      headers: auth,
    });
    expect(res.status).toBe(504);
  });
});

describe("rate limit", () => {
  it("answers 429 with Retry-After past the budget", async () => {
    const app = make(new Fake(), { RATE_PER_MIN: 2 });
    expect((await app.request("/search.json?q=a", { headers: auth })).status).toBe(200);
    expect((await app.request("/search.json?q=a", { headers: auth })).status).toBe(200);
    const res = await app.request("/search.json?q=a", { headers: auth });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
  const xff = (ip: string) => ({ headers: { ...auth, "X-Forwarded-For": `${ip}, 10.0.0.1` } });
  it("keys on the first X-Forwarded-For address with TRUST_PROXY", async () => {
    const app = make(new Fake(), { RATE_PER_MIN: 1, TRUST_PROXY: true });
    expect((await app.request("/search.json?q=a", xff("1.1.1.1"))).status).toBe(200);
    expect((await app.request("/search.json?q=a", xff("2.2.2.2"))).status).toBe(200);
    expect((await app.request("/search.json?q=a", xff("1.1.1.1"))).status).toBe(429);
  });
  it("ignores X-Forwarded-For without TRUST_PROXY", async () => {
    const app = make(new Fake(), { RATE_PER_MIN: 1 });
    expect((await app.request("/search.json?q=a", xff("1.1.1.1"))).status).toBe(200);
    expect((await app.request("/search.json?q=a", xff("2.2.2.2"))).status).toBe(429);
  });
});

describe("/health", () => {
  it("needs no key", async () => {
    const res = await make().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "ok" });
  });
  it("is 503 unless ok", async () => {
    expect((await make(new Fake(0, "down")).request("/health")).status).toBe(503);
  });
});

describe("openapi", () => {
  it("is served without auth and lists every query param with its limits", async () => {
    const res = await make().request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = JSON.parse(await res.text());
    expect(doc.openapi).toBe("3.1.0");
    const params = doc.paths["/search.json"].get.parameters as { name: string; required: boolean; schema: Record<string, unknown> }[];
    expect(params.map((p) => p.name).sort()).toEqual(Object.keys(querySchema(3).shape).sort());
    const by = Object.fromEntries(params.map((p) => [p.name, p]));
    expect(by.q).toMatchObject({ required: true, schema: { maxLength: 2048 } });
    expect(by.pages!.schema).toMatchObject({ minimum: 1, maximum: base.MAX_PAGES });
    expect(by.links_wait!.schema).toMatchObject({ minimum: 0, maximum: 120 });
    expect(by.hl!.required).toBe(false);
    expect(doc.components.schemas.Record.properties.search_metadata.properties.timings).toBeTruthy();
    expect(Object.keys(doc.paths["/search.json"].get.responses)).toEqual(expect.arrayContaining(["400", "401", "429", "504"]));
  });

  it("still goes through the rate limiter", async () => {
    const app = make(new Fake(), { RATE_PER_MIN: 1 });
    expect((await app.request("/openapi.json")).status).toBe(200);
    expect((await app.request("/openapi.json")).status).toBe(429);
  });
});

describe("cache header", () => {
  it("sends X-Cache MISS then HIT for single-page synchronous requests, none for pages > 1", async () => {
    const fake = new Fake();
    const app = make(new CachingSearcher(fake, 60_000, 10));
    const first = await app.request("/search.json?q=shoes", { headers: auth });
    expect(first.headers.get("X-Cache")).toBe("MISS");
    const second = await app.request("/search.json?q=shoes", { headers: auth });
    expect(second.headers.get("X-Cache")).toBe("HIT");
    expect((await second.json()).search_metadata.cached).toBe(true);
    expect(fake.calls.length).toBe(1);
    const multi = await app.request("/search.json?q=shoes&pages=2", { headers: auth });
    expect(multi.headers.get("X-Cache")).toBeNull();
    const health = await app.request("/health");
    expect((await health.json()).cache).toEqual({ size: 2 });
  });
});

describe("format", () => {
  it.each([
    ["format=markdown", {}, "text/markdown", "# shoes"],
    ["format=text", {}, "text/plain", "shoes"],
    ["", { Accept: "text/markdown" }, "text/markdown", "# shoes"],
    ["", { Accept: "text/plain" }, "text/plain", "shoes"],
    ["format=json", { Accept: "text/markdown" }, "application/json", "{"],
    ["", { Accept: "text/html,*/*" }, "application/json", "{"],
  ])("%s %j → %s", async (query, headers, type, start) => {
    const res = await make().request(`/search.json?q=shoes&${query}`, { headers: { ...auth, ...headers } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain(type);
    expect((await res.text()).startsWith(start)).toBe(true);
  });
  it("renders every page in order", async () => {
    const res = await make().request("/search.json?q=shoes&pages=2&format=markdown", { headers: auth });
    expect(await res.text()).toMatch(/^# shoes\n[\s\S]*\n# shoes \(page 2\)\n$/);
  });
  it("rejects an unknown format", async () => {
    const res = await make().request("/search.json?q=shoes&format=xml", { headers: auth });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "format must be json, markdown or text" });
  });
});

describe("date", () => {
  it("maps date onto tbs, after a given tbs", async () => {
    const fake = new Fake();
    await make(fake).request("/search.json?q=shoes&date=w&tbs=li:1", { headers: auth });
    await make(fake).request("/search.json?q=shoes&date=20240101..20240131", { headers: auth });
    expect(fake.calls.map((c) => c.tbs)).toEqual(["li:1,qdr:w", "cdr:1,cd_min:1/1/2024,cd_max:1/31/2024"]);
    expect(fake.calls[0]).not.toHaveProperty("date");
  });
  it("rejects a bad date", async () => {
    const res = await make().request("/search.json?q=shoes&date=yesterday", { headers: auth });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^date must be/);
  });
});

describe("POST /parse", () => {
  const html = gunzipSync(readFileSync(new URL("fixtures/car-insurance-quote.html.gz", import.meta.url))).toString();
  const post = (body: string, headers: Record<string, string> = auth, query = "") =>
    make().request(`/parse${query}`, { method: "POST", body, headers: { "Content-Type": "text/html", ...headers } });

  it("classifies and parses a page", async () => {
    const res = await post(html, auth, "?hl=en&url=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dx");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page_verdict).toBe("serp");
    expect(body.organic_results.length).toBeGreaterThanOrEqual(8);
    expect(body).not.toHaveProperty("goto_links");
    expect(body).not.toHaveProperty("ping_paths");
  });
  it("answers 413 over 5 MB", async () => {
    const res = await post("x".repeat(5 * 1024 * 1024 + 1));
    expect(res.status).toBe(413);
  });
  it("needs the API key and validates hl", async () => {
    expect((await post(html, {})).status).toBe(401);
    expect((await post(html, auth, "?hl=x")).status).toBe(400);
  });
});

describe("extract", () => {
  const page = (url: string): Extracted => ({ url, status: 200, title: `T ${url}`, markdown: `# md ${url}`, text: `text ${url}` });
  const fakeExtract = () => {
    const asked: string[][] = [];
    const fn: ExtractFn = async (urls) => (asked.push(urls), [...new Set(urls)].map(page));
    return { fn, asked };
  };
  const app = (ex = fakeExtract(), s: Searcher = new Fake()) => createApp(s, base, () => {}, ex.fn);
  const post = (body: unknown) =>
    ({ method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) }) as const;

  it("GET answers one page; format=markdown answers its body", async () => {
    const ex = fakeExtract();
    const res = await app(ex).request("/extract?url=https://a.example/x", { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: "https://a.example/x", markdown: "# md https://a.example/x" });
    const md = await app(ex).request("/extract?url=https://a.example/x&format=markdown", { headers: auth });
    expect(md.headers.get("Content-Type")).toContain("text/markdown");
    expect(await md.text()).toBe("# md https://a.example/x\n");
  });

  it("POST {urls} answers an array, deduped; text format puts a heading per URL", async () => {
    const ex = fakeExtract();
    const res = await app(ex).request("/extract", post({ urls: ["https://a.example/", "https://b.example/", "https://a.example/"] }));
    expect((await res.json()).map((p: Extracted) => p.url)).toEqual(["https://a.example/", "https://b.example/"]);
    const txt = await app(ex).request("/extract?format=text", post({ urls: ["https://a.example/", "https://b.example/"] }));
    expect(await txt.text()).toBe("https://a.example/\n\ntext https://a.example/\n\nhttps://b.example/\n\ntext https://b.example/\n");
    const one = await app(ex).request("/extract", post({ url: "https://a.example/" }));
    expect(Array.isArray(await one.json())).toBe(false);
  });

  it.each([
    ["GET without url", "/extract", undefined, "url is required"],
    ["GET ftp url", "/extract?url=ftp://a.example/", undefined, "url must be an http(s) URL"],
    ["POST bad url", "/extract", { urls: ["not a url"] }, "url must be an http(s) URL"],
    ["POST over 20", "/extract", { urls: Array.from({ length: 21 }, (_, i) => `https://a.example/${i}`) }, "urls takes at most 20 URLs"],
    ["POST both", "/extract", { url: "https://a.example/", urls: ["https://b.example/"] }, "give url or urls"],
    ["POST neither", "/extract", {}, "give url or urls"],
  ])("400s %s", async (_name, path, body, error) => {
    const ex = fakeExtract();
    const res = await app(ex).request(path, body === undefined ? { headers: auth } : post(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(ex.asked).toHaveLength(0);
  });

  it("is in the OpenAPI document", async () => {
    const doc = await (await app().request("/openapi.json")).json();
    expect(Object.keys(doc.paths["/extract"])).toEqual(["get", "post"]);
    expect(doc.components.schemas.Extracted.required).toContain("markdown");
  });

  it("needs the API key like /search", async () => {
    expect((await app().request("/extract?url=https://a.example/")).status).toBe(401);
  });

  it("search extract=N attaches pages to the first N linked results and raises links", async () => {
    const ex = fakeExtract();
    const s = new Fake();
    const linked: Searcher = {
      health: () => s.health(),
      async search(p) {
        const r = await s.search(p);
        return { ...r, organic_results: [{ title: "a", link: "https://a.example/" }, { title: "n", link: null }, { title: "b", link: "https://b.example/" }, { title: "c", link: "https://c.example/" }] };
      },
    };
    const res = await app(ex, linked).request("/search.json?q=x&links=0&extract=2", { headers: auth });
    const body = await res.json();
    expect(s.calls[0]!.links).toBe(2);
    expect(ex.asked).toEqual([["https://a.example/", "https://b.example/"]]);
    expect(body.organic_results.map((o: any) => o.extracted?.title)).toEqual(["T https://a.example/", undefined, "T https://b.example/", undefined]);
    expect((await app(ex, linked).request("/search.json?q=x&extract=6", { headers: auth })).status).toBe(400);
    await app(ex, linked).request("/search.json?q=x", { headers: auth });
    expect(ex.asked).toHaveLength(1); // extract defaults to 0
  });
});
