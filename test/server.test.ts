import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createApp } from "../src/server/app.js";
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
  ])("%s -> 400", async (url, error) => {
    const res = await make().request(url, { headers: auth });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
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
