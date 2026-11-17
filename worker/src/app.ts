// Cloudflare Worker egress, two authenticated routes:
// - GET /tunnel tunnels raw TCP over a WebSocket (Google search: keeps Chrome's TLS fingerprint).
// - GET /fetch fetches one URL with the Worker's own fetch(), for page extraction only. Workers cannot
//   open TCP sockets to Cloudflare-hosted sites, but fetch() reaches them. The upstream request is built
//   fresh from the URL and the x-fetch-header-* values; nothing of the incoming request (its IP headers,
//   Authorization, cookies) is forwarded, so the origin sees a Cloudflare address, never the caller's.
// Types are structural so this file also compiles (and is tested) under Node.

import { Hono } from "hono";

export interface TcpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}
export type Connect = (address: { hostname: string; port: number }) => TcpSocket;

interface WorkerWebSocket {
  accept(): void;
  send(data: ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", fn: () => void): void;
}
type Pair = new () => { 0: WorkerWebSocket; 1: WorkerWebSocket };
export type Fetch = (req: Request) => Promise<Response>;

const PORTS = new Set([80, 443]);
export const FETCH_MAX_BYTES = 3 * 1024 * 1024;
const HEADER_PREFIX = "x-fetch-header-";

function privateV4(h: string): boolean {
  const o = h.split(".").map(Number) as [number, number, number, number];
  const [a, b] = o;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128);
}

/** `host:port` from X-Connect-Host, or null when the port or address is not allowed. */
export function parseTarget(v: string | undefined): { hostname: string; port: number } | null {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^\s:[\]/?#@]+)):(\d{1,5})$/.exec(v ?? "");
  if (!m) return null;
  const port = Number(m[3]);
  if (!PORTS.has(port)) return null;
  let host: string;
  try {
    // URL canonicalises odd IPv4 forms (0x7f.1, 2130706433) and compresses IPv6.
    host = new URL(`http://${m[1] ? `[${m[1]}]` : m[2]}/`).hostname;
  } catch {
    return null;
  }
  if (host.startsWith("[")) {
    host = host.slice(1, -1);
    // "::"-prefixed covers unspecified, loopback, v4-mapped and v4-compatible addresses.
    if (host.startsWith("::") || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return null;
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && privateV4(host)) {
    return null;
  }
  return { hostname: host, port };
}

async function tokenOk(header: string | undefined, token: string | undefined): Promise<boolean> {
  if (!header || !token) return false;
  const enc = new TextEncoder();
  // Hash first so the comparison is constant time and leaks no length.
  const [a, b] = await Promise.all(
    [header, `Bearer ${token}`].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))),
  );
  const x = new Uint8Array(a!), y = new Uint8Array(b!);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** The upstream body, cut at `max` bytes. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > max) {
        chunks.push(value.subarray(0, max - size));
        size = max;
        truncated = true;
        reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      size += value.length;
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) (bytes.set(c, at), (at += c.length));
  return { bytes, truncated };
}

export function createApp(connect: Connect, fetcher: Fetch = (req) => fetch(req)) {
  const app = new Hono<{ Bindings: { EGRESS_TOKEN?: string } }>();

  app.get("/tunnel", async (c) => {
    // The token is checked before anything else, so this handler answers 401 to any wrong or missing token.
    // A live 400 for `Upgrade: websocket` without Sec-WebSocket-Key comes from Cloudflare's edge, which
    // rejects malformed upgrade requests before the Worker runs; nothing below can produce a 400.
    if (!(await tokenOk(c.req.header("authorization"), c.env?.EGRESS_TOKEN))) return c.text("unauthorized", 401);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.text("websocket upgrade required", 426);
    const target = parseTarget(c.req.header("x-connect-host"));
    if (!target) return c.text("target not allowed", 403);

    const pair = new (globalThis as unknown as { WebSocketPair: Pair }).WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    const sock = connect(target);
    const writer = sock.writable.getWriter();

    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      try { server.close(1000); } catch { /* already closed */ }
      sock.close().catch(() => {});
    };
    server.addEventListener("message", (e) => {
      const d = e.data;
      const bytes = typeof d === "string" ? new TextEncoder().encode(d) : new Uint8Array(d as ArrayBuffer);
      writer.write(bytes).catch(done);
    });
    server.addEventListener("close", done);
    server.addEventListener("error", done);
    sock.readable
      .pipeTo(new WritableStream({ write: (chunk) => server.send(chunk) }))
      .catch(() => {})
      .finally(done);

    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  });

  app.get("/fetch", async (c) => {
    if (!(await tokenOk(c.req.header("authorization"), c.env?.EGRESS_TOKEN))) return c.text("unauthorized", 401);
    let url: URL;
    try {
      url = new URL(c.req.query("url") ?? "");
    } catch {
      return c.text("target not allowed", 403);
    }
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !parseTarget(`${url.hostname}:${port}`)) {
      return c.text("target not allowed", 403);
    }
    // Only the x-fetch-header-* values go upstream, renamed; nothing else of the incoming request.
    const headers = new Headers();
    for (const [k, v] of Object.entries(c.req.header())) {
      if (k.startsWith(HEADER_PREFIX) && k.length > HEADER_PREFIX.length) headers.set(k.slice(HEADER_PREFIX.length), v);
    }
    let res: Response;
    let body: { bytes: Uint8Array; truncated: boolean };
    try {
      res = await fetcher(new Request(url.href, { method: "GET", headers, redirect: "manual" }));
      // shortcut: buffered up to the cap, not streamed, so x-fetch-truncated can be a header; stream if 3 MB of Worker memory matters.
      body = await readCapped(res.body, FETCH_MAX_BYTES);
    } catch (err) {
      return c.text(`fetch failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), 502);
    }
    const upstream: Record<string, string> = {};
    res.headers.forEach((v, k) => void (upstream[k] = v));
    const out = new Headers({ "x-fetch-status": String(res.status), "x-fetch-headers": JSON.stringify(upstream), "content-type": "application/octet-stream" });
    if (body.truncated) out.set("x-fetch-truncated", "1");
    return new Response(body.bytes.buffer as ArrayBuffer, { status: 200, headers: out });
  });

  return app;
}
