import { afterEach, describe, expect, it, vi } from "vitest";
import { type Connect, createApp, type Fetch, FETCH_MAX_BYTES, parseTarget } from "../worker/src/app.js";

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

  it("401 for a wrong token on a well-formed websocket upgrade", async () => {
    const upgrade = { ...ok, connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };
    expect((await get("/tunnel", { ...upgrade, authorization: "Bearer wrong-token" })).status).toBe(401);
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

describe("worker fetch", () => {
  const auth = { authorization: "Bearer egress-secret" };
  const fakeFetch = (res: () => Response = () => new Response("<p>hi</p>", { status: 200, headers: { "content-type": "text/html" } })) => {
    const seen: Request[] = [];
    const f = vi.fn<Fetch>(async (req) => (seen.push(req), res()));
    return { f, seen };
  };
  const get = (f: Fetch, url: string, headers: Record<string, string> = auth, e: object = env) =>
    createApp(noConnect, f).request(`/fetch?url=${encodeURIComponent(url)}`, { headers }, e);

  it("checks the token first", async () => {
    const { f } = fakeFetch();
    expect((await get(f, "https://example.com/", {})).status).toBe(401);
    expect((await get(f, "http://127.0.0.1/", { authorization: "Bearer nope" })).status).toBe(401);
    expect((await get(f, "https://example.com/", auth, {})).status).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });

  it("403 on bad URLs, ports, schemes and private addresses", async () => {
    const { f } = fakeFetch();
    for (const u of ["", "not a url", "ftp://example.com/", "file:///etc/passwd", "https://example.com:8443/", "http://127.0.0.1/",
      "http://10.0.0.1/", "http://169.254.169.254/latest", "http://[::1]/", "http://0x7f.1/", "https://u:p@example.com/"]) {
      expect((await get(f, u)).status, u).toBe(403);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("builds a fresh request: only x-fetch-header-* go upstream, redirect manual", async () => {
    const { f, seen } = fakeFetch();
    const r = await get(f, "https://example.com/a?b=1", {
      ...auth,
      "x-fetch-header-user-agent": "UA",
      "x-fetch-header-accept-language": "en",
      "x-forwarded-for": "1.2.3.4",
      "cf-connecting-ip": "1.2.3.4",
      cookie: "c=1",
      "user-agent": "caller",
    });
    expect(r.status).toBe(200);
    const req = seen[0]!;
    expect(req.url).toBe("https://example.com/a?b=1");
    expect(req.method).toBe("GET");
    expect(req.redirect).toBe("manual");
    expect(Object.fromEntries(req.headers)).toEqual({ "user-agent": "UA", "accept-language": "en" });
  });

  it("relays the upstream status and headers in x-fetch-*, with status 200", async () => {
    const { f } = fakeFetch(() => new Response(null, { status: 301, headers: { location: "https://example.com/new", "content-type": "text/html" } }));
    const r = await get(f, "http://example.com/old");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-fetch-status")).toBe("301");
    expect(JSON.parse(r.headers.get("x-fetch-headers")!)).toMatchObject({ location: "https://example.com/new", "content-type": "text/html" });
    expect(r.headers.get("x-fetch-truncated")).toBeNull();
    const ok = await get(fakeFetch().f, "https://example.com/");
    expect(await ok.text()).toBe("<p>hi</p>");
  });

  it("cuts the body at 3 MB and marks it", async () => {
    const big = new Uint8Array(FETCH_MAX_BYTES + 10).fill(97);
    const { f } = fakeFetch(() => new Response(big));
    const r = await get(f, "https://example.com/big");
    expect(r.headers.get("x-fetch-truncated")).toBe("1");
    expect((await r.arrayBuffer()).byteLength).toBe(FETCH_MAX_BYTES);
  });

  it("502 when the fetch throws", async () => {
    const f: Fetch = async () => { throw new Error("boom"); };
    const r = await get(f, "https://example.com/");
    expect(r.status).toBe(502);
    expect(await r.text()).toContain("boom");
  });
});
