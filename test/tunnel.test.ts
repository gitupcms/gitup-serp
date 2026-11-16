import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebSocketStream, WebSocketServer } from "ws";
import { EgressTunnel } from "../src/egress/tunnel.js";

const TOKEN = "tunnel-test-token-123";
const listen = (s: net.Server) =>
  new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as net.AddressInfo).port)));

let echo: net.Server, worker: http.Server, dead: net.Server, tunnel: EgressTunnel;
let deadHits = 0;
const targets: string[] = [];
let proxy: URL;
let workerPort: number;
const usageFile = join(mkdtempSync(join(tmpdir(), "openserp-tunnel-")), "usage.json");

beforeAll(async () => {
  echo = net.createServer((s) => s.pipe(s));
  const echoPort = await listen(echo);

  // Fake Worker: checks the Bearer token, then pipes the WebSocket to the local echo server.
  worker = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  worker.on("upgrade", (req, socket, head) => {
    if (req.url !== "/tunnel" || req.headers.authorization !== `Bearer ${TOKEN}`) {
      return socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    }
    targets.push(String(req.headers["x-connect-host"]));
    wss.handleUpgrade(req, socket, head, (ws) => {
      const tcp = net.connect(echoPort, "127.0.0.1");
      const stream = createWebSocketStream(ws);
      stream.on("error", () => tcp.destroy());
      tcp.on("error", () => stream.destroy());
      tcp.pipe(stream).pipe(tcp);
    });
  });
  workerPort = await listen(worker);

  // Dead Worker: accepts TCP and drops it, counting attempts.
  dead = net.createServer((s) => (deadHits++, s.destroy()));
  const deadPort = await listen(dead);

  tunnel = new EgressTunnel({ workers: [`http://127.0.0.1:${deadPort}`, `http://127.0.0.1:${workerPort}`], token: TOKEN, usageFile });
  proxy = new URL((await tunnel.start()).url);
});

afterAll(async () => {
  await tunnel.close();
  for (const s of [echo, worker, dead]) s.close();
});

const auth = () => `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;

function connect(headers: Record<string, string>, via = proxy): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: via.port, method: "CONNECT", path: "www.google.com:443", headers });
    req.once("connect", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.once("error", reject);
    req.end();
  });
}

function roundTrip(socket: net.Socket, msg: string): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (d) => resolve(d.toString()));
    socket.write(msg);
  });
}

describe("egress tunnel", () => {
  it("listens on loopback with generated credentials", () => {
    expect(proxy.hostname).toBe("127.0.0.1");
    expect(proxy.password).toMatch(/^[0-9a-f]{32}$/);
  });

  it("407 without or with wrong proxy auth", async () => {
    const a = await connect({});
    expect(a.status).toBe(407);
    a.socket.destroy();
    const b = await connect({ "proxy-authorization": "Basic d3Jvbmc6Y3JlZHM=" });
    expect(b.status).toBe(407);
    b.socket.destroy();
  });

  it("405 on plain HTTP", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: proxy.port, path: "http://example.com/", headers: { "proxy-authorization": auth() } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .once("error", reject);
    });
    expect(status).toBe(405);
  });

  it("CONNECT works end to end; the dead worker is cooled down and skipped", async () => {
    const first = await connect({ "proxy-authorization": auth() });
    expect(first.status).toBe(200);
    expect(await roundTrip(first.socket, "ping")).toBe("ping");
    first.socket.destroy();
    expect(deadHits).toBe(1);
    expect(targets.at(-1)).toBe("www.google.com:443");

    // Round-robin points at the dead worker again, but it is cooling down.
    const second = await connect({ "proxy-authorization": auth() });
    expect(second.status).toBe(200);
    expect(await roundTrip(second.socket, "pong")).toBe("pong");
    second.socket.destroy();
    expect(deadHits).toBe(1);
    // Three Worker requests: dead + live, then live. Written on the first dial and again on close().
    expect(tunnel.usage.today).toBe(3);
  });

  it("429 once the daily limit is used up", async () => {
    const t = new EgressTunnel({ workers: [`http://127.0.0.1:${workerPort}`], token: TOKEN, usageFile: `${usageFile}.limit`, dailyLimit: 1 });
    const via = new URL((await t.start()).url);
    const a = `Basic ${Buffer.from(`${via.username}:${via.password}`).toString("base64")}`;
    try {
      const first = await connect({ "proxy-authorization": a }, via);
      expect(first.status).toBe(200);
      first.socket.destroy();
      const second = await connect({ "proxy-authorization": a }, via);
      expect(second.status).toBe(429);
      second.socket.destroy();
    } finally {
      await t.close();
    }
    expect(JSON.parse(readFileSync(`${usageFile}.limit`, "utf8")).count).toBe(1);
  });
});
