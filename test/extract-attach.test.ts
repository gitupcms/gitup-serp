import { beforeEach, describe, expect, it, vi } from "vitest";

const curl = vi.hoisted(() => ({ calls: [] as string[], reply: { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } }));
vi.mock("cuimp", () => ({
  runBinary: async (_bin: string, _args: string[], opts: { stdin: string }) => {
    curl.calls.push(opts.stdin);
    return curl.reply;
  },
}));

import { attachExtracts, type ExtractFn, extractor, linksFor } from "../src/extract/attach.js";
import { CurlPageHttp, egressHttp, extractPage, type FetchVia, NO_EGRESS, type PageHttp, PROXY_REFUSED } from "../src/extract/index.js";
import { ProxyTemplate } from "../src/scraper/proxy.js";
import type { SerpRecord } from "../src/types.js";

const reply = (exitCode: number, stdout = "", stderr = "") => {
  curl.reply = { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
};
const PAGE = `HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\n<html><head><title>T</title></head><body><article><p>${"word ".repeat(60)}</p></article></body></html>`;

beforeEach(() => {
  curl.calls = [];
  reply(0, PAGE);
});

describe("CurlPageHttp through the egress", () => {
  it("passes the proxy and its credentials in the stdin config, never argv", async () => {
    const ep = new ProxyTemplate("http://user-{session}:p%40ss@gate.example:8080").forSession("abc");
    const r = await extractPage("https://site.example/a", { http: new CurlPageHttp(ep) });
    expect(r.error).toBeUndefined();
    expect(r.title).toBe("T");
    const cfg = curl.calls[0]!;
    expect(cfg).toContain('url = "https://site.example/a"');
    expect(cfg).toContain('proxy = "http://gate.example:8080"');
    expect(cfg).toContain('proxy-user = "user-abc:p@ss"');
  });

  it("egressHttp builds a proxied side from the egress URL", async () => {
    await extractPage("https://site.example/a", { http: egressHttp("http://127.0.0.1:9000") });
    expect(curl.calls[0]).toContain('proxy = "http://127.0.0.1:9000"');
  });

  it.each(["403", "502"])("maps a CONNECT %s from a user proxy to a proxy refusal, with no Worker fallback", async (code) => {
    reply(56, "", `curl: (56) CONNECT tunnel failed, response ${code}`);
    const r = await extractPage("https://cf-site.example/", { http: egressHttp("http://127.0.0.1:9000") });
    expect(r.error).toBe(PROXY_REFUSED);
    expect(curl.calls).toHaveLength(1); // no direct retry
  });

  it("over the tunnel, retries a refused URL once through the Worker's fetch, per hop", async () => {
    reply(56, "", "curl: (56) CONNECT tunnel failed, response 403");
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const fetchVia: FetchVia = async (url, headers): ReturnType<FetchVia> => {
      asked.push({ url, headers });
      return url.endsWith("/old")
        ? { status: 301, headers: { Location: "/new" }, body: Buffer.alloc(0) }
        : { status: 200, headers: { "Content-Type": "text/html" }, body: Buffer.from(PAGE.split("\r\n\r\n")[1]!) };
    };
    const r = await extractPage("https://cf-site.example/old", { http: egressHttp("http://127.0.0.1:9000", fetchVia) });
    expect(r).toMatchObject({ url: "https://cf-site.example/new", status: 200, title: "T", via: "worker-fetch" });
    expect(r.error).toBeUndefined();
    expect(asked.map((a) => a.url)).toEqual(["https://cf-site.example/old", "https://cf-site.example/new"]);
    expect(asked[0]!.headers["user-agent"]).toMatch(/Chrome\//);
    expect(curl.calls).toHaveLength(2); // the tunnel is tried first on every hop
  });

  it("over the tunnel, a TLS handshake the Worker drops (curl 35) also falls back to the Worker's fetch", async () => {
    reply(35, "", "curl: (35) BoringSSL SSL_connect: Connection closed abruptly (SSL_ERROR_SYSCALL; error queue empty)");
    const fetchVia: FetchVia = async () => ({ status: 200, headers: { "Content-Type": "text/html" }, body: Buffer.from(PAGE.split("\r\n\r\n")[1]!) });
    const r = await extractPage("https://cf-site.example/", { http: egressHttp("http://127.0.0.1:9000", fetchVia) });
    expect(r.via).toBe("worker-fetch");
  });

  it("over the tunnel, serves from the tunnel and does not fall back on other errors", async () => {
    const fetchVia: FetchVia = async () => { throw new Error("must not be called"); };
    const ok = await extractPage("https://site.example/a", { http: egressHttp("http://127.0.0.1:9000", fetchVia) });
    expect(ok.via).toBe("tunnel");
    reply(28, "", "curl: (28) Operation timed out");
    const r = await extractPage("https://site.example/a", { http: egressHttp("http://127.0.0.1:9000", fetchVia) });
    expect(r.error).toMatch(/^curl exit 28/);
  });

  it("over the tunnel, a Worker fetch failure surfaces as the error", async () => {
    reply(56, "", "curl: (56) CONNECT tunnel failed, response 502");
    const fetchVia: FetchVia = async () => { throw new Error("worker fetch: target not allowed"); };
    const r = await extractPage("https://cf-site.example/", { http: egressHttp("http://127.0.0.1:9000", fetchVia) });
    expect(r.error).toBe("worker fetch: target not allowed");
  });

  it("a user proxy marks pages via proxy", async () => {
    const r = await extractPage("https://site.example/a", { http: egressHttp("http://127.0.0.1:9000") });
    expect(r.via).toBe("proxy");
  });

  it("without an egress fails every page and runs no curl", async () => {
    const r = await extractPage("https://site.example/a", { http: egressHttp(undefined) });
    expect(r).toMatchObject({ markdown: "", error: NO_EGRESS });
    const def = await extractPage("https://site.example/a");
    expect(def.error).toBe(NO_EGRESS);
    expect(curl.calls).toHaveLength(0);
  });
});

describe("extractor", () => {
  it("caps pages in flight across calls and drops duplicates", async () => {
    let active = 0;
    let peak = 0;
    const asked: string[] = [];
    const http: PageHttp = {
      async get(url) {
        asked.push(url);
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { status: 404, headers: { "content-type": "text/html" }, body: Buffer.alloc(0) };
      },
    };
    const ex = extractor(2, { http });
    const [a, b] = await Promise.all([ex(["https://a.example/1", "https://a.example/2", "https://a.example/1"]), ex(["https://b.example/1", "https://b.example/2"])]);
    expect(a.map((p) => p.url)).toEqual(["https://a.example/1", "https://a.example/2"]);
    expect(b).toHaveLength(2);
    expect(asked).toHaveLength(4);
    expect(peak).toBe(2);
  });
});

describe("attachExtracts", () => {
  const rec = (links: (string | null)[]): SerpRecord =>
    ({ search_metadata: {}, search_parameters: {}, organic_results: links.map((link, i) => ({ position: i + 1, title: `t${i}`, link })) }) as unknown as SerpRecord;
  const fake: ExtractFn = async (urls) =>
    urls.map((url) => (url.includes("bad") ? { url, status: 500, markdown: "", text: "", error: "HTTP 500" } : { url, status: 200, title: `T ${url}`, markdown: `# ${url}`, text: url }));

  it("puts the first N linked results' pages under them, across records, skipping null links", async () => {
    const records = [rec(["https://a.example/", null, "https://bad.example/"]), rec(["https://a.example/", "https://c.example/"])];
    const asked: string[][] = [];
    const n = await attachExtracts(records, 3, async (u) => (asked.push(u), fake(u)));
    expect(n).toBe(3);
    const [o1, o2] = [records[0]!.organic_results as any[], records[1]!.organic_results as any[]];
    expect(o1[0].extracted).toEqual({ markdown: "# https://a.example/", title: "T https://a.example/" });
    expect(o1[1].extracted).toBeUndefined();
    expect(o1[2].extracted).toEqual({ markdown: "", error: "HTTP 500" });
    expect(o2[0].extracted).toEqual(o1[0].extracted); // same URL, extracted once
    expect(o2[1].extracted).toBeUndefined();
    expect(asked).toEqual([["https://a.example/", "https://bad.example/", "https://a.example/"]]);
  });

  it("does nothing for 0", async () => {
    const records = [rec(["https://a.example/"])];
    expect(await attachExtracts(records, 0, fake)).toBe(0);
    expect((records[0]!.organic_results as any[])[0].extracted).toBeUndefined();
  });

  it("linksFor raises links to at least extract; unset stays all", () => {
    expect(linksFor(0, 3)).toBe(3);
    expect(linksFor(5, 3)).toBe(5);
    expect(linksFor(undefined, 3)).toBeUndefined();
  });
});
