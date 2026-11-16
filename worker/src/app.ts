// Cloudflare Worker egress: one authenticated route that tunnels raw TCP over a WebSocket.
// No fetch/HTTP-relay mode on purpose: a relay adds X-Forwarded-For and leaks the caller's IP.
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

const PORTS = new Set([80, 443]);

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

export function createApp(connect: Connect) {
  const app = new Hono<{ Bindings: { EGRESS_TOKEN?: string } }>();

  app.get("/tunnel", async (c) => {
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

  return app;
}
