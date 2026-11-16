import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMcpHandler } from "../src/mcp/index.js";
import type { SearchParams, Searcher, SerpRecord } from "../src/types.js";

function record(p: SearchParams, extra: Record<string, unknown> = {}): SerpRecord {
  return {
    search_metadata: {
      id: "x",
      status: "Success",
      created_at: "",
      total_time_taken: 0,
      google_url: null,
      page_verdict: "serp",
      verdict_reason: null,
    },
    search_parameters: { ...p, engine: "google", device: "desktop" },
    ...extra,
  };
}

class Fake implements Searcher {
  calls: SearchParams[] = [];
  constructor(private make: (p: SearchParams) => SerpRecord) {}
  async search(p: SearchParams) {
    this.calls.push(p);
    return this.make(p);
  }
  health() {
    return { state: "ok" as const };
  }
}

const rpc = (id: number | undefined, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, params });
const callTool = (args: unknown) => rpc(1, "tools/call", { name: "google_search", arguments: args });

describe("mcp handler", () => {
  const noSearcher = () => Promise.reject(new Error("should not start"));

  it("negotiates the protocol version without starting the runtime", async () => {
    const h = createMcpHandler(noSearcher);
    const r = (await h(rpc(1, "initialize", { protocolVersion: "2025-03-26" }))) as any;
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.capabilities.tools).toBeDefined();
    const newest = (await h(rpc(2, "initialize", { protocolVersion: "1999-01-01" }))) as any;
    expect(newest.result.protocolVersion).toBe("2025-06-18");
  });

  it("lists google_search with its schema", async () => {
    const r = (await createMcpHandler(noSearcher)(rpc(1, "tools/list"))) as any;
    const [tool] = r.result.tools;
    expect(tool.name).toBe("google_search");
    expect(tool.inputSchema.required).toEqual(["query"]);
    expect(tool.inputSchema.properties.pages).toMatchObject({ minimum: 1, maximum: 3, default: 1 });
    expect(tool.inputSchema.properties.links).toMatchObject({ minimum: 0, default: 10 });
  });

  it("returns compact results for each page", async () => {
    const fake = new Fake((p) =>
      record(p, {
        organic_results: [
          { position: p.page, title: "T", link: "https://a.example/", snippet: "S", source: "A", displayed_link: "a.example" },
          { position: 9, title: "U", link: null, displayed_link: "b.example › x" },
        ],
        related_questions: [{ question: "why?" }],
        related_searches: [{ query: "more", link: "/x" }],
        ai_overview: { text: "overview" },
        local_results: [{ position: 1, title: "Cafe", rating: 4.5, extensions: ["x"] }],
      }),
    );
    const r = (await createMcpHandler(async () => fake)(callTool({ query: " cats ", pages: 2, gl: "us" }))) as any;
    expect(r.result.isError).toBe(false);
    expect(fake.calls).toEqual([
      { q: "cats", page: 1, hl: "en", gl: "us", links: 10 },
      { q: "cats", page: 2, hl: "en", gl: "us", links: 10 },
    ]);
    const body = JSON.parse(r.result.content[0].text);
    expect(body.results[0]).toEqual({ position: 1, title: "T", link: "https://a.example/", snippet: "S", source: "A" });
    expect(body.results[1]).toEqual({ position: 9, title: "U", site: "b.example" });
    expect(body.results).toHaveLength(4);
    expect(body.related_questions).toEqual(["why?", "why?"]);
    expect(body.related_searches).toEqual(["more", "more"]);
    expect(body.ai_overview).toBe("overview");
    expect(body.places).toEqual([{ title: "Cafe", rating: 4.5 }]);
    expect(body.errors).toBeUndefined();
  });

  it("reports failures as isError, never a crash", async () => {
    const errRecord = new Fake((p) => ({ ...record(p), error: "blocked" }));
    const a = (await createMcpHandler(async () => errRecord)(callTool({ query: "x" }))) as any;
    expect(a.result.isError).toBe(true);
    expect(JSON.parse(a.result.content[0].text).errors).toEqual(["blocked"]);

    const thrower = new Fake(() => {
      throw new Error("boom");
    });
    const b = (await createMcpHandler(async () => thrower)(callTool({ query: "x" }))) as any;
    expect(b.result).toMatchObject({ isError: true, content: [{ type: "text", text: "Error: boom" }] });

    const c = (await createMcpHandler(noSearcher)(callTool({ query: "x" }))) as any;
    expect(c.result.isError).toBe(true);
  });

  it("rejects invalid arguments before searching", async () => {
    const h = createMcpHandler(noSearcher);
    for (const [args, msg] of [
      [{}, "query is required"],
      [{ query: "x", pages: 4 }, "pages must be between 1 and 3"],
      [{ query: "x", links: -1 }, "links must be 0 or more"],
      [{ query: "x", gl: "usa" }, "gl must be"],
    ] as const) {
      const r = (await h(callTool(args))) as any;
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toContain(msg);
    }
    const unknown = (await h(rpc(1, "tools/call", { name: "nope" }))) as any;
    expect(unknown.error.code).toBe(-32602);
  });

  it("answers unknown methods with -32601 and ignores notifications", async () => {
    const h = createMcpHandler(noSearcher);
    expect(((await h(rpc(7, "resources/list"))) as any).error).toMatchObject({ code: -32601 });
    expect(await h(rpc(undefined, "notifications/initialized"))).toBeUndefined();
    expect(await h(rpc(undefined, "notifications/whatever"))).toBeUndefined();
    expect(((await h(rpc(3, "ping"))) as any).result).toEqual({});
  });
});

describe("mcp over stdio", () => {
  it("writes only JSON lines to stdout", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const child = spawn("npx", ["tsx", "src/mcp/index.ts"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stdin.write(`${JSON.stringify(rpc(1, "initialize", { protocolVersion: "2024-11-05" }))}\n`);
    child.stdin.write(`${JSON.stringify(rpc(undefined, "notifications/initialized"))}\n`);
    child.stdin.write(`${JSON.stringify(rpc(2, "tools/list"))}\n`);
    child.stdin.end();
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    const lines = out.split("\n").filter(Boolean);
    expect(out.endsWith("\n")).toBe(true);
    const msgs = lines.map((l) => JSON.parse(l));
    expect(msgs.map((m) => m.id)).toEqual([1, 2]);
    expect(msgs[0].result.protocolVersion).toBe("2024-11-05");
    expect(msgs[1].result.tools[0].name).toBe("google_search");
  }, 30_000);
});
