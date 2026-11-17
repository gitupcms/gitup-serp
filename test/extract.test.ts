import { describe, expect, it } from "vitest";
import { extractHtml, extractMany, extractPage, parseResponse, type PageHttp, type PageResponse } from "../src/extract/index.js";

const html = (body: string, head = "") => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
const ok = (body: string, type = "text/html; charset=utf-8"): PageResponse => ({ status: 200, headers: { "content-type": type }, body: Buffer.from(body) });
const LONG = "Hiking boots need a stiff sole, a good fit and waterproof uppers. ".repeat(5);

/** A fake HTTP side: a response per URL, and the URLs asked for in order. */
function fake(pages: Record<string, PageResponse>): PageHttp & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async get(url) {
      asked.push(url);
      const r = pages[url];
      if (!r) throw new Error(`no page for ${url}`);
      return r;
    },
  };
}

const ARTICLE = html(
  `<header><a href="/">Home</a></header>
   <nav><a href="/a">Menu link</a></nav>
   <div class="cookie-banner">We use cookies</div>
   <div id="sidebar"><p>Sidebar text that is long enough to tempt the paragraph scorer, but must go.</p></div>
   <article>
     <h1>Best boots</h1>
     <p>${LONG}</p>
     <p>See <a href="/guide?x=1">the guide</a> and <a href="https://other.example/p">this</a>.</p>
     <img src="/i.png" alt="A boot">
     <ul><li>Sole</li><li>Fit</li></ul>
     <pre><code>size = 42</code></pre>
     <table><tr><th>Model</th><th>Price</th></tr><tr><td>X1</td><td>$100</td></tr></table>
     <div class="share-buttons">Share on X</div>
   </article>
   <footer>Copyright</footer>
   <script>alert(1)</script>`,
  `<title> Boots guide </title><meta name="description" content="All about boots"><link rel="canonical" href="/boots">`,
);

describe("extractPage", () => {
  it("removes boilerplate and picks the article, with metadata and absolute links", async () => {
    const http = fake({ "https://site.example/dir/page": ok(ARTICLE) });
    const r = await extractPage("https://site.example/dir/page", { http });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({
      url: "https://site.example/dir/page",
      status: 200,
      title: "Boots guide",
      description: "All about boots",
      lang: "en",
      canonical: "https://site.example/boots",
    });
    expect(r.markdown).toMatch(/^# Best boots/);
    expect(r.markdown).toContain("[the guide](https://site.example/guide?x=1)");
    expect(r.markdown).toContain("[this](https://other.example/p)");
    expect(r.markdown).toContain("A boot");
    expect(r.markdown).not.toContain("i.png");
    expect(r.markdown).toMatch(/^-\s+Sole$/m);
    expect(r.markdown).toContain("```\nsize = 42\n```");
    expect(r.markdown).toContain("| Model | Price |\n| --- | --- |\n| X1 | $100 |");
    for (const junk of ["Menu link", "cookies", "Sidebar", "Share on", "Copyright", "alert", "Home"]) expect(r.markdown).not.toContain(junk);
    expect(r.markdown).not.toMatch(/\n{3,}/);
    expect(r.text).toContain("See the guide and this.");
    expect(r.text).not.toMatch(/[#[\]()`]/);
  });

  it("without article/main, picks the element with the most paragraph text", async () => {
    const page = html(`<div class="intro"><p>short</p></div><div class="content"><p>${LONG}</p><p>${LONG}</p></div>`);
    const r = await extractPage("https://a.example/", { http: fake({ "https://a.example/": ok(page) }) });
    expect(r.text).toContain("Hiking boots");
    expect(r.text).not.toContain("short");
  });

  it("keeps a wrapper of <main> even when its class looks like boilerplate", () => {
    const body = "Hono is a small web framework. ".repeat(10);
    const r = extractHtml(`<html><body><div class="VPContent has-sidebar"><main><h1>Docs</h1><p>${body}</p></main></div></body></html>`, "https://x.test/");
    expect(r.markdown).toContain("Hono is a small web framework.");
  });

  it("rejects non-HTML content", async () => {
    const r = await extractPage("https://a.example/f.pdf", { http: fake({ "https://a.example/f.pdf": ok("%PDF-1.7", "application/pdf") }) });
    expect(r).toEqual({ url: "https://a.example/f.pdf", status: 200, markdown: "", text: "", error: "unsupported content type: application/pdf" });
  });

  it("follows redirects and reports the final URL", async () => {
    const http = fake({
      "http://a.example/old": { status: 301, headers: { location: "https://a.example/new" }, body: Buffer.alloc(0) },
      "https://a.example/new": { status: 302, headers: { location: "/final" }, body: Buffer.alloc(0) },
      "https://a.example/final": ok(ARTICLE),
    });
    const r = await extractPage("http://a.example/old", { http });
    expect(http.asked).toEqual(["http://a.example/old", "https://a.example/new", "https://a.example/final"]);
    expect(r.url).toBe("https://a.example/final");
    expect(r.markdown).toContain("[the guide](https://a.example/guide?x=1)");
  });

  it("stops after 5 redirects", async () => {
    const http: PageHttp = { get: async (u) => ({ status: 302, headers: { location: `${u}x` }, body: Buffer.alloc(0) }) };
    const r = await extractPage("https://a.example/", { http });
    expect(r.error).toBe("more than 5 redirects");
  });

  it("flags little content but still returns it", async () => {
    const r = await extractPage("https://a.example/", { http: fake({ "https://a.example/": ok(html('<div id="app"><p>Loading…</p></div>')) }) });
    expect(r.markdown).toBe("Loading…");
    expect(r.error).toBe("little content (8 chars); the page may need JavaScript");
  });

  it("returns errors instead of throwing, redacted; throws on abort", async () => {
    const http: PageHttp = { get: async () => { throw new Error("connect to http://user:pw@proxy failed"); } };
    const r = await extractPage("https://a.example/", { http });
    expect(r).toMatchObject({ status: null, markdown: "", error: "connect to http://***@proxy failed" });
    expect((await extractPage("file:///etc/passwd", { http })).error).toBe("unsupported URL scheme: file:");
    const ac = new AbortController();
    ac.abort();
    const aborting: PageHttp = { get: async (_, s) => { s?.throwIfAborted(); return ok(""); } };
    await expect(extractPage("https://a.example/", { http: aborting, signal: ac.signal })).rejects.toThrow();
  });
});

describe("extractMany", () => {
  it("keeps the order and drops duplicates", async () => {
    let active = 0;
    let peak = 0;
    const http: PageHttp = {
      async get(url) {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, url.endsWith("1") ? 20 : 1));
        active--;
        return ok(html(`<main><p>${url} ${LONG}</p></main>`));
      },
    };
    const urls = ["https://a.example/1", "https://a.example/2", "https://a.example/1", "https://a.example/3", "https://a.example/4"];
    const r = await extractMany(urls, { http, parallel: 2 });
    expect(r.map((x) => x.url)).toEqual(["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4"]);
    expect(r[0]!.text).toContain("https://a.example/1");
    expect(peak).toBe(2);
  });
});

describe("parseResponse", () => {
  it("skips interim heads and lower-cases header names", () => {
    const r = parseResponse(Buffer.from("HTTP/1.1 100 Continue\r\n\r\nHTTP/2 200\r\nContent-Type: text/html\r\n\r\n<p>x</p>"));
    expect(r).toEqual({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<p>x</p>") });
  });
});
