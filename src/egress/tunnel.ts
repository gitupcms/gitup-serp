// Local CONNECT proxy on 127.0.0.1 that carries each tunnel over a WebSocket to an egress Worker.
// Uses the `ws` package: Node's global WebSocket cannot send the Authorization header.

import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { createWebSocketStream } from "ws";

export interface TunnelOptions {
  workers: string[]; // https://<name>.<sub>.workers.dev
  token: string;
  cooldownMs?: number;
  maxCooldownMs?: number;
}

/** A Worker answered but refused the target (403): not the Worker's fault, so no cooldown. */
class TargetRefused extends Error {}

export class EgressTunnel {
  private readonly server = http.createServer((_req, res) => {
    res.writeHead(405, { allow: "CONNECT", connection: "close" }).end();
  });
  private readonly user = "openserp";
  private readonly pass = randomBytes(16).toString("hex");
  private readonly expected = Buffer.from(`Basic ${Buffer.from(`${this.user}:${this.pass}`).toString("base64")}`);
  private readonly sockets = new Set<Duplex>();
  private readonly health = new Map<string, { fails: number; until: number }>();
  private next = 0;

  constructor(private readonly opts: TunnelOptions) {
    if (opts.workers.length === 0) throw new Error("egress: no workers, run npm run egress:up");
    this.server.on("connect", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => this.onConnect(req, socket, head));
  }

  async start(): Promise<{ url: string }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = this.server.address() as { port: number };
    return { url: `http://${this.user}:${this.pass}@127.0.0.1:${port}` };
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private authOk(header: string | undefined): boolean {
    const got = Buffer.from(header ?? "");
    return got.length === this.expected.length && timingSafeEqual(got, this.expected);
  }

  private onConnect(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    const reply = (status: string, extra = "") => socket.end(`HTTP/1.1 ${status}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);

    if (!this.authOk(req.headers["proxy-authorization"])) {
      return reply("407 Proxy Authentication Required", 'Proxy-Authenticate: Basic realm="openserp"\r\n');
    }
    const target = req.url ?? "";
    if (!/^[\w.-]+:\d{1,5}$|^\[[0-9a-fA-F:.]+\]:\d{1,5}$/.test(target)) return reply("400 Bad Request");

    this.open(target).then(
      (ws) => {
        if (socket.destroyed) return ws.terminate();
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const stream = createWebSocketStream(ws);
        stream.on("error", () => socket.destroy());
        socket.once("close", () => stream.destroy());
        if (head.length) stream.write(head);
        socket.pipe(stream).pipe(socket);
      },
      (err) => reply(err instanceof TargetRefused ? "403 Forbidden" : "502 Bad Gateway"),
    );
  }

  /** Round-robin over Workers not in cooldown; a Worker that fails is cooled down and the next one tried. */
  private async open(target: string): Promise<WebSocket> {
    const { workers } = this.opts;
    const start = this.next;
    for (let i = 0; i < workers.length; i++) {
      const idx = (start + i) % workers.length;
      const url = workers[idx]!;
      if ((this.health.get(url)?.until ?? 0) > Date.now()) continue;
      this.next = (idx + 1) % workers.length;
      try {
        const ws = await this.dial(url, target);
        this.health.delete(url);
        return ws;
      } catch (err) {
        if (err instanceof TargetRefused) throw err;
        const fails = (this.health.get(url)?.fails ?? 0) + 1;
        const ms = Math.min((this.opts.cooldownMs ?? 5_000) * 2 ** (fails - 1), this.opts.maxCooldownMs ?? 300_000);
        this.health.set(url, { fails, until: Date.now() + ms });
      }
    }
    throw new Error("egress: every worker failed or is cooling down");
  }

  private dial(worker: string, target: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${worker.replace(/^http/, "ws").replace(/\/$/, "")}/tunnel`, {
        headers: { authorization: `Bearer ${this.opts.token}`, "x-connect-host": target },
        handshakeTimeout: 10_000,
      });
      ws.once("open", () => resolve(ws));
      ws.once("unexpected-response", (_req, res) => {
        ws.terminate();
        reject(res.statusCode === 403 ? new TargetRefused() : new Error(`worker answered ${res.statusCode}`));
      });
      ws.on("error", reject); // stays attached: terminate() and later stream errors emit here too
    });
  }
}
