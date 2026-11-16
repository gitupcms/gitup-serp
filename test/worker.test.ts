import { afterEach, describe, expect, it, vi } from "vitest";
import { type Connect, createApp, parseTarget } from "../worker/src/app.js";

const env = { EGRESS_TOKEN: "egress-secret" };
const ok = { authorization: "Bearer egress-secret", upgrade: "websocket", "x-connect-host": "www.google.com:443" };
const noConnect: Connect = () => {
  throw new Error("connect must not be called");
};

describe("worker guard", () => {
  const app = createApp(noConnect);
  const get = (path: string, headers: Record<string, string>, e: object = env) => app.request(path, { headers }, e);

  it("401 without, with a wrong, or with no configured token", async () => {
    const { authorization: _, ...noAuth } = ok;
    expect((await get("/tunnel", noAuth)).status).toBe(401);
    expect((await get("/tunnel", { ...ok, authorization: "Bearer nope" })).status).toBe(401);
    expect((await get("/tunnel", { ...ok, authorization: "Bearer " })).status).toBe(401);
    expect((await get("/tunnel", ok, {})).status).toBe(401);
  });

  it("404 on other paths and methods", async () => {
    expect((await get("/", ok)).status).toBe(404);
    expect((await get("/tunnel/x", ok)).status).toBe(404);
    expect((await app.request("/tunnel", { method: "POST", headers: ok }, env)).status).toBe(404);
  });

  it("426 without a websocket upgrade", async () => {
    expect((await get("/tunnel", { ...ok, upgrade: "" })).status).toBe(426);
  });

  it("403 on disallowed ports and private addresses", async () => {
    for (const t of ["www.google.com:22", "www.google.com:8080", "127.0.0.1:443", "10.1.2.3:80", "192.168.0.1:443",
      "172.20.0.1:443", "169.254.169.254:80", "0x7f.1:443", "2130706433:443", "[::1]:443", "[::ffff:127.0.0.1]:443",
      "[fe80::1]:443", "[fd00::1]:443", "www.google.com", "a b:443", ""]) {
      expect((await get("/tunnel", { ...ok, "x-connect-host": t })).status, t).toBe(403);
    }
  });
});

describe("parseTarget", () => {
  it("accepts public hosts on 80 and 443", () => {
    expect(parseTarget("www.google.com:443")).toEqual({ hostname: "www.google.com", port: 443 });
    expect(parseTarget("8.8.8.8:80")).toEqual({ hostname: "8.8.8.8", port: 80 });
    expect(parseTarget("[2001:4860:4860::8888]:443")).toEqual({ hostname: "2001:4860:4860::8888", port: 443 });
  });
});

describe("worker tunnel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts the upgrade, connects to the target and pipes both ways", async () => {
    const listeners: Record<string, (e: { data: unknown }) => void> = {};
    const sent: Uint8Array[] = [];
    const fakeWs = () => ({
      accept: vi.fn(),
      send: (d: Uint8Array) => sent.push(d),
      close: vi.fn(),
      addEventListener: (t: string, fn: (e: { data: unknown }) => void) => (listeners[t] = fn),
    });
    const server = fakeWs();
    vi.stubGlobal("WebSocketPair", class { 0 = fakeWs(); 1 = server; });

    const written: Uint8Array[] = [];
    let push!: (b: Uint8Array) => void;
    const connect = vi.fn<Connect>(() => ({
      readable: new ReadableStream<Uint8Array>({ start: (c) => void (push = (b) => c.enqueue(b)) }),
      writable: new WritableStream<Uint8Array>({ write: (b) => void written.push(b) }),
      close: async () => {},
    }));

    // Node's Response refuses status 101, so the handler ends in a 500 here; the Workers runtime accepts it.
    await createApp(connect).request("/tunnel", { headers: ok }, env);
    expect(connect).toHaveBeenCalledWith({ hostname: "www.google.com", port: 443 });
    expect(server.accept).toHaveBeenCalled();

    listeners.message!({ data: new TextEncoder().encode("hello").buffer });
    push(new TextEncoder().encode("world"));
    await new Promise((r) => setTimeout(r, 10));
    expect(new TextDecoder().decode(written[0])).toBe("hello");
    expect(new TextDecoder().decode(sent[0])).toBe("world");

    listeners.close!({ data: undefined });
    expect(server.close).toHaveBeenCalled();
  });
});
