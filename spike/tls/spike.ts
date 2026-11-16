// TLS impersonation spike: each client hits tls.peet.ws (A) and Google (B), direct and, if SPIKE_PROXY is set, via proxy.
import { writeFileSync } from "node:fs";
import { Impit } from "impit";
import { createCuimpHttp } from "cuimp";
import { ProxyAgent } from "undici";
import { chromium } from "patchright";

const PEET = "https://tls.peet.ws/api/all";
const GOOGLE = "https://www.google.com/search?q=weather+istanbul&hl=en&gl=us";
const BIN = `${import.meta.dirname}/bin/curl_chrome152`;
const proxy = process.env.SPIKE_PROXY || "";
const proxyLabel = proxy ? (() => { const u = new URL(proxy); return `${u.hostname}:${u.port}`; })() : "";
// Library errors (e.g. curl stderr) can echo the proxy URL; never let credentials reach logs or results.json.
const clean = (m: string) => String(m).split(proxy || "\0").join(proxyLabel).replace(/\/\/[^\s/@]+@/g, "//***@");

// Chrome-like header set for the control client; impersonating clients bring their own and only get accept-language.
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const CHROME_HEADERS: Record<string, string> = {
  "sec-ch-ua": '"Chromium";v="152", "Not)A;Brand";v="24", "Google Chrome";v="152"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "upgrade-insecure-requests": "1",
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
  "sec-fetch-user": "?1",
  "sec-fetch-dest": "document",
  "accept-encoding": "gzip, deflate, br, zstd",
  "accept-language": "en-US,en;q=0.9",
  priority: "u=0, i",
};
const LANG = { "accept-language": "en-US,en;q=0.9" };

type Res = { status: number; location: string; body: string };
type Client = { name: string; open(p: string): Promise<{ get(url: string): Promise<Res>; close(): Promise<void> }> };

const clients: Client[] = [
  {
    name: "impit",
    async open(p) {
      const c = new Impit({ browser: "chrome151", proxyUrl: p || undefined, followRedirects: false, timeout: 30000 });
      return {
        async get(url) {
          const r = await c.fetch(url, { headers: LANG });
          return { status: r.status, location: r.headers.get("location") ?? "", body: await r.text() };
        },
        async close() {},
      };
    },
  },
  {
    name: "cuimp (curl_chrome152)",
    async open(p) {
      const c = createCuimpHttp({ path: BIN, proxy: p || undefined });
      return {
        async get(url) {
          const r = await c.get(url, { headers: LANG, maxRedirects: 0, proxy: p || undefined } as any);
          return { status: r.status, location: r.headers.location ?? r.headers.Location ?? "", body: r.rawBody.toString("utf8") };
        },
        async close() {},
      };
    },
  },
  {
    name: "fetch (undici)",
    async open(p) {
      const dispatcher = p ? new ProxyAgent(p) : undefined;
      return {
        async get(url) {
          const r = await fetch(url, { headers: CHROME_HEADERS, redirect: "manual", ...(dispatcher ? { dispatcher } : {}) } as any);
          return { status: r.status, location: r.headers.get("location") ?? "", body: await r.text() };
        },
        async close() { await dispatcher?.close(); },
      };
    },
  },
  {
    name: "patchright chromium (ref)",
    async open(p) {
      const u = p ? new URL(p) : null;
      const browser = await chromium.launch({
        headless: true,
        channel: "chromium", // full Chromium in new headless mode, not headless_shell
        proxy: u ? { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : undefined,
      });
      const page = await browser.newPage({ locale: "en-US" });
      return {
        async get(url) {
          const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
          // the page may redirect (e.g. to /sorry); record where it ended up
          const final = page.url();
          return { status: r?.status() ?? 0, location: final === url ? "" : final, body: url === PEET ? (await r?.text()) ?? "" : await page.content() };
        },
        async close() { await browser.close(); },
      };
    },
  },
];

function fingerprint(body: string) {
  const j = JSON.parse(body);
  const frames = j.http2?.sent_frames ?? [];
  const hdr = frames.find((f: any) => f.frame_type === "HEADERS")?.headers ?? j.http1?.headers ?? [];
  return {
    http_version: j.http_version,
    ja3_hash: j.tls?.ja3_hash,
    ja4: j.tls?.ja4,
    akamai: j.http2?.akamai_fingerprint,
    akamai_hash: j.http2?.akamai_fingerprint_hash,
    header_order: hdr.map((h: string) => h.replace(/^(:?[^:]+):.*$/, "$1")),
    user_agent: j.user_agent,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: any = { date: new Date().toISOString(), proxy: proxyLabel || null, runs: {} };

async function run(mode: "direct" | "proxy", p: string) {
  for (const cl of clients) {
    const rec: any = { A: null, B: [] };
    out.runs[`${cl.name} | ${mode}`] = rec;
    let s;
    try { s = await cl.open(p); } catch (e: any) { rec.error = `open: ${clean(e.message)}`; console.log(cl.name, mode, rec.error); continue; }
    try { rec.A = fingerprint((await s.get(PEET)).body); } catch (e: any) { rec.A = { error: clean(e.message) }; }
    console.log(`[${mode}] ${cl.name} A`, JSON.stringify({ ...rec.A, header_order: undefined }));
    for (let i = 0; i < 3; i++) {
      if (i) await sleep(5000);
      try {
        const r = await s.get(GOOGLE);
        rec.B.push({ status: r.status, location: r.location, sorry: /\/sorry|consent\./.test(r.location) || /\/sorry\//.test(r.body.slice(0, 2000)), rso: r.body.includes('id="rso"'), bytes: Buffer.byteLength(r.body) });
      } catch (e: any) { rec.B.push({ error: clean(e.message) }); }
      console.log(`[${mode}] ${cl.name} B#${i + 1}`, JSON.stringify(rec.B[i]));
    }
    await s.close();
  }
}

await run("direct", "");
if (proxy) await run("proxy", proxy);
else console.log("SPIKE_PROXY missing: skipping proxy runs (fill spike/tls/.env, see .env.example)");

// Compare each client's A fingerprint with the patchright reference of the same mode.
for (const mode of ["direct", "proxy"]) {
  const ref = out.runs[`patchright chromium (ref) | ${mode}`]?.A;
  if (!ref?.ja4) continue;
  for (const cl of clients) {
    const a = out.runs[`${cl.name} | ${mode}`]?.A;
    if (!a?.ja4) continue;
    a.match = { ja3: a.ja3_hash === ref.ja3_hash, ja4: a.ja4 === ref.ja4, akamai: a.akamai_hash === ref.akamai_hash, header_order: a.header_order.join() === ref.header_order.join() };
    console.log(`[${mode}] ${cl.name} vs ref`, JSON.stringify(a.match));
  }
}
writeFileSync(`${import.meta.dirname}/results.json`, JSON.stringify(out, null, 2));
console.log("wrote results.json");
