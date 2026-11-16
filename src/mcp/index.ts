// MCP server over stdio: newline-delimited JSON-RPC 2.0, one tool `google_search`.
// Hand-written against the MCP spec (no SDK), after serpmaven's mcp.py (MIT).
// stdout carries protocol messages only; every log goes to stderr.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { startRuntime, type Runtime } from "../bootstrap.js";
import { glSchema, hlSchema, searchDefaults, type SearchDefaults } from "../config.js";
import type { Searcher, SerpRecord } from "../types.js";

export const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const MAX_PAGES = 3;
const DEFAULT_LINKS = 10;

const TOOL = {
  name: "google_search",
  title: "Google search",
  annotations: { readOnlyHint: true, openWorldHint: true },
  description:
    "Search Google through a real browser. Returns organic results (position, title, link, snippet, " +
    "source, date), 'People also ask' questions, related searches, the AI Overview and map places " +
    "when Google shows them. The first call starts the browser and can take a while.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      pages: {
        type: "integer",
        minimum: 1,
        maximum: MAX_PAGES,
        default: 1,
        description: "Result pages to fetch (about 10 results each).",
      },
      hl: { type: "string", description: "Interface language of the results, e.g. en, de, pt-BR." },
      gl: { type: "string", description: "Country the results are for, two letters, e.g. us, de." },
      links: {
        type: "integer",
        minimum: 0,
        default: DEFAULT_LINKS,
        description:
          "How many of the top results on each page get their full URL resolved. Each is a separate " +
          "lookup, so a smaller number answers sooner; 0 skips them.",
      },
    },
    required: ["query"],
  },
};

// Same rules as the HTTP API's query schema (src/server/app.ts).
const argsSchema = z.object({
  query: z.string({ error: "query is required" }).trim().min(1, "query is required").max(2048),
  pages: z
    .number({ error: "pages must be an integer" })
    .int("pages must be an integer")
    .min(1, `pages must be between 1 and ${MAX_PAGES}`)
    .max(MAX_PAGES, `pages must be between 1 and ${MAX_PAGES}`)
    .default(1),
  hl: hlSchema.optional(),
  gl: glSchema.optional(),
  links: z
    .number({ error: "links must be an integer" })
    .int("links must be an integer")
    .min(0, "links must be 0 or more")
    .default(DEFAULT_LINKS),
});

type Json = Record<string, unknown>;
type Obj = Record<string, any>;

/** What a model needs from the records, without the SERP API bookkeeping. */
export function compact(records: SerpRecord[]) {
  const out: Json & { results: Json[]; related_questions: string[]; related_searches: string[] } = {
    results: [],
    related_questions: [],
    related_searches: [],
  };
  const errors: string[] = [];
  for (const record of records) {
    if (record.error !== undefined || record.search_metadata.status === "Error") {
      errors.push(record.error ?? "search failed");
      continue;
    }
    for (const r of (record.organic_results as Obj[] | undefined) ?? []) {
      const result: Json = {};
      for (const k of ["position", "title", "link", "snippet", "source", "date"]) {
        if (r[k] != null) result[k] = r[k];
      }
      const site = String(r.displayed_link ?? "").split(" ")[0];
      if (result.link === undefined && site) result.site = site;
      out.results.push(result);
    }
    const overview = (record.ai_overview as Obj | undefined)?.text;
    if (overview && out.ai_overview === undefined) out.ai_overview = overview;
    const places = (record.local_results as Obj[] | undefined) ?? [];
    if (places.length && out.places === undefined) {
      const keep = ["title", "rating", "reviews", "type", "address", "phone", "hours"];
      out.places = places.map((p) => Object.fromEntries(keep.filter((k) => k in p).map((k) => [k, p[k]])));
    }
    out.related_questions.push(...((record.related_questions as Obj[] | undefined) ?? []).map((q) => q.question));
    out.related_searches.push(...((record.related_searches as Obj[] | undefined) ?? []).map((s) => s.query));
  }
  if (errors.length) out.errors = errors;
  return out;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const toolError = (text: string) => ({ content: [{ type: "text", text }], isError: true });

/**
 * One JSON-RPC message in, the reply out (undefined for notifications).
 * `getSearcher` is only called on the first `tools/call`, so `initialize` is instant.
 */
export function createMcpHandler(getSearcher: () => Promise<Searcher>, defaults: SearchDefaults = searchDefaults({})) {
  async function call(params: Obj) {
    if (params.name !== TOOL.name) throw new RpcError(-32602, `unknown tool: ${String(params.name)}`);
    const parsed = argsSchema.safeParse(params.arguments ?? {});
    if (!parsed.success) return toolError(parsed.error.issues[0]!.message);
    const { query, pages, hl = defaults.hl, gl = defaults.gl, ...rest } = parsed.data;
    let records: SerpRecord[] = [];
    try {
      const searcher = await getSearcher();
      for (let page = 1; page <= pages; page++) records.push(await searcher.search({ q: query, page, hl, gl, ...rest }));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (!records.length) return toolError(`${e.name}: ${e.message}`);
      // Keep the pages already fetched; report the failed one alongside them.
      records = [...records, { error: `${e.name}: ${e.message}` } as SerpRecord];
    }
    const body = compact(records);
    const empty = !body.results.length && !body.ai_overview && !body.places;
    return {
      content: [{ type: "text", text: JSON.stringify(body) }],
      isError: empty && body.errors !== undefined,
    };
  }

  async function dispatch(method: unknown, params: Obj): Promise<Json> {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return {
          protocolVersion: (SUPPORTED_VERSIONS as readonly unknown[]).includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "openserp", version: "0.0.1" },
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: [TOOL] };
      case "tools/call":
        return call(params);
      default:
        throw new RpcError(-32601, `method not found: ${String(method)}`);
    }
  }

  return async function handle(message: unknown): Promise<Json | undefined> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
    }
    const { id, method, params } = message as Obj;
    if (id === undefined || id === null) return undefined; // a notification (or a response): never answered
    try {
      const p = typeof params === "object" && params !== null ? params : {};
      return { jsonrpc: "2.0", id, result: await dispatch(method, p) };
    } catch (err) {
      const e = err instanceof RpcError ? err : new RpcError(-32603, String(err));
      return { jsonrpc: "2.0", id, error: { code: e.code, message: e.message } };
    }
  };
}

/** Serve stdin/stdout until stdin ends or a signal arrives; the runtime starts on the first tool call. */
export async function serve(): Promise<void> {
  let runtime: Promise<Runtime> | undefined;
  const getSearcher = async () => {
    runtime ??= startRuntime().catch((err) => {
      runtime = undefined; // let the next call retry
      throw err;
    });
    return (await runtime).searcher;
  };
  const handle = createMcpHandler(getSearcher, searchDefaults());
  const write = (m: Json) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const pending = new Set<Promise<void>>();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await Promise.allSettled(pending);
    await (await runtime?.catch(() => undefined))?.close();
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => void shutdown().finally(() => process.exit(0)));
  }

  for await (const raw of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const line = raw.trim();
    if (!line) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    // Calls run concurrently so a ping is not stuck behind a slow search.
    const p: Promise<void> = handle(message)
      .then((reply) => void (reply && write(reply)))
      .catch((err) => console.error("mcp:", err))
      .finally(() => pending.delete(p));
    pending.add(p);
  }
  await shutdown();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
