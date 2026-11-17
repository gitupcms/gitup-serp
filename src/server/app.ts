import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { z } from "zod";
import { classify } from "../classify/index.js";
import { attachExtracts, type ExtractFn, extractor, linksFor, MAX_EXTRACT, MAX_EXTRACT_URLS } from "../extract/attach.js";
import { egressHttp } from "../extract/index.js";
import { type Config, dateSchema, dateTbs, glSchema, hlSchema, httpUrlSchema, linksWaitSchema } from "../config.js";
import { parseSerp } from "../parse/index.js";
import { render, renderPages } from "../render.js";
import type { SearchParams, Searcher, SerpRecord } from "../types.js";
import { openapiDoc } from "./openapi.js";
import { JobTimeoutError, Queue, QueueFullError } from "./queue.js";

const ARCHIVE_SIZE = 500;
const ARCHIVE_TTL_MS = 3_600_000;
const PARSE_MAX_BYTES = 5 * 1024 * 1024;
const CONTENT_TYPE = { markdown: "text/markdown; charset=utf-8", text: "text/plain; charset=utf-8" } as const;

type Body =
  | SerpRecord
  | SerpRecord[]
  | { search_metadata: { id: string; status: "Processing" | "Error" }; error?: string };

/** Insertion-ordered Map as an LRU with a TTL from creation. */
class Archive {
  private items = new Map<string, { body: Body; created: number }>();

  set(id: string, body: Body): void {
    const created = this.items.get(id)?.created ?? Date.now();
    this.items.delete(id);
    this.items.set(id, { body, created });
    while (this.items.size > ARCHIVE_SIZE) this.items.delete(this.items.keys().next().value!);
  }

  get(id: string): Body | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    this.items.delete(id);
    if (Date.now() - item.created > ARCHIVE_TTL_MS) return undefined;
    this.items.set(id, item);
    return item.body;
  }
}

/** Token bucket per client, refilled continuously at `perMin` tokens per minute. */
class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();
  constructor(private readonly perMin: number) {}

  /** Seconds to wait, or 0 if the request may go. */
  take(key: string): number {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.perMin, last: now };
    b.tokens = Math.min(this.perMin, b.tokens + ((now - b.last) * this.perMin) / 60_000);
    b.last = now;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.prune();
    if (b.tokens < 1) return Math.ceil(((1 - b.tokens) * 60_000) / this.perMin / 1000);
    b.tokens -= 1;
    return 0;
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (now - b.last > 60_000) this.buckets.delete(k);
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest();
const optional = z.string().trim().max(256).optional();

export function querySchema(maxPages: number) {
  return z.object({
    q: z.string({ error: "q is required" }).trim().min(1, "q is required").max(2048),
    pages: z.coerce
      .number({ error: "pages must be an integer" })
      .int("pages must be an integer")
      .min(1, `pages must be between 1 and ${maxPages}`)
      .max(maxPages, `pages must be between 1 and ${maxPages}`)
      .default(1),
    hl: hlSchema.optional(),
    gl: glSchema.optional(),
    location: optional,
    tbs: optional,
    date: dateSchema.optional(),
    cr: optional,
    lr: optional,
    links: z.coerce
      .number({ error: "links must be an integer" })
      .int("links must be an integer")
      .min(0, "links must be 0 or more")
      .optional(),
    links_wait: z.coerce.number({ error: "links_wait must be a number" }).pipe(linksWaitSchema).optional(),
    extract: z.coerce
      .number({ error: "extract must be an integer" })
      .int("extract must be an integer")
      .min(0, `extract must be between 0 and ${MAX_EXTRACT}`)
      .max(MAX_EXTRACT, `extract must be between 0 and ${MAX_EXTRACT}`)
      .default(0),
    async: z.enum(["true", "false", "1", "0"], { error: "async must be true or false" }).optional(),
    format: z.enum(["json", "markdown", "text"], { error: "format must be json, markdown or text" }).optional(),
  });
}

const formatSchema = z.enum(["json", "markdown", "text"], { error: "format must be json, markdown or text" }).optional();
const extractQuerySchema = z.object({ url: httpUrlSchema.optional(), format: formatSchema });
const extractBodySchema = z
  .object({
    url: httpUrlSchema.optional(),
    urls: z
      .array(httpUrlSchema, { error: "urls must be an array of URLs" })
      .min(1, "urls must not be empty")
      .max(MAX_EXTRACT_URLS, `urls takes at most ${MAX_EXTRACT_URLS} URLs`)
      .optional(),
  })
  .refine((b) => (b.url === undefined) !== (b.urls === undefined), "give url or urls");

const parseQuerySchema = z.object({ hl: hlSchema.optional(), url: z.string().max(2048).optional() });

/** `format`, else the Accept header's text/markdown or text/plain, else json. */
function pickFormat(format: string | undefined, accept = ""): "json" | "markdown" | "text" {
  if (format) return format as "json" | "markdown" | "text";
  if (accept.includes("text/markdown")) return "markdown";
  if (accept.includes("text/plain")) return "text";
  return "json";
}

function failure(err: unknown): { status: 429 | 504 | 500; error: string } {
  if (err instanceof QueueFullError) return { status: 429, error: err.message };
  if (err instanceof JobTimeoutError) return { status: 504, error: err.message };
  const e = err instanceof Error ? err : new Error(String(err));
  return { status: 500, error: `${e.name}: ${e.message}` };
}

export function createApp(
  searcher: Searcher,
  cfg: Config,
  log: (line: string) => void = (line) => console.log(line),
  // Without an egress every page fails with NO_EGRESS; src/index.ts passes the runtime's egress.
  extract: ExtractFn = extractor(cfg.EXTRACT_PARALLEL, { http: egressHttp() }),
) {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const queue = new Queue(cfg.MAX_CONCURRENCY, cfg.MAX_QUEUE, cfg.REQUEST_TIMEOUT_MS);
  const archive = new Archive();
  const limiter = new RateLimiter(cfg.RATE_PER_MIN);
  const schema = querySchema(cfg.MAX_PAGES);
  const keyHash = cfg.OPENSERP_API_KEY ? sha(cfg.OPENSERP_API_KEY) : undefined;
  const doc = openapiDoc(schema);

  // Path only: the query string may carry search terms.
  app.use(async (c, next) => {
    const start = performance.now();
    await next();
    log(
      JSON.stringify({
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - start),
      }),
    );
  });

  app.get("/health", (c) => {
    const h = searcher.health();
    return c.json(h, h.state === "ok" ? 200 : 503);
  });

  app.use(async (c, next) => {
    if (c.req.query("api_key") !== undefined) return c.json({ error: "use Authorization header" }, 400);
    // TRUST_PROXY: the first X-Forwarded-For entry is whatever the client sent unless the proxy overwrites it.
    const forwarded = cfg.TRUST_PROXY ? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() : undefined;
    const ip = forwarded || (c.env?.incoming?.socket?.remoteAddress ?? "unknown");
    const wait = limiter.take(ip);
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    // The OpenAPI document holds no data: rate-limited, but open.
    if (keyHash && c.req.path !== "/openapi.json") {
      const header = c.req.header("Authorization") ?? "";
      const given = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!timingSafeEqual(sha(given), keyHash)) return c.json({ error: "missing or wrong API key" }, 401);
    }
    await next();
  });

  const search = async (c: Context<{ Bindings: HttpBindings }>) => {
    const parsed = schema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]!.message }, 400);
    const { pages, async: asyncFlag, format, date, extract: n, hl = cfg.DEFAULT_HL, gl = cfg.DEFAULT_GL, ...rest } = parsed.data;
    if (date) rest.tbs = dateTbs(date, rest.tbs);
    rest.links = linksFor(rest.links, n);
    const as = pickFormat(format, c.req.header("Accept"));
    const newId = () => randomUUID().replaceAll("-", "");
    const id = newId();

    const job = (signal: AbortSignal) =>
      (async () => {
        const records: SerpRecord[] = [];
        for (let page = 1; page <= pages; page++) {
          const params: SearchParams = { ...rest, hl, gl, page };
          const r = await searcher.search(params, signal);
          // Each page of a multi-page request is also fetchable on its own id.
          const pageId = pages === 1 ? id : newId();
          const record = { ...r, search_metadata: { ...r.search_metadata, id: pageId } };
          if (pages > 1) archive.set(pageId, record);
          records.push(record);
        }
        return pages === 1 ? records[0]! : records;
      })();
    // Outside the search queue: extraction does not hold a scraper slot.
    const searchAndExtract = async (signal?: AbortSignal): Promise<SerpRecord | SerpRecord[]> => {
      const body = await queue.run(job);
      await attachExtracts(Array.isArray(body) ? body : [body], n, extract, signal);
      return body;
    };

    if (queue.full) return c.json({ error: "server is busy, try again later" }, 429);

    if (asyncFlag === "true" || asyncFlag === "1") {
      const processing = { search_metadata: { id, status: "Processing" as const } };
      archive.set(id, processing);
      searchAndExtract().then(
        (body) => archive.set(id, body),
        (err) => archive.set(id, { search_metadata: { id, status: "Error" }, error: failure(err).error }),
      );
      return c.json(processing);
    }

    try {
      const body = await searchAndExtract(c.req.raw.signal);
      archive.set(id, body);
      if (!Array.isArray(body)) c.header("X-Cache", body.search_metadata.cached ? "HIT" : "MISS");
      if (as === "json") return c.json(body);
      return c.body(render(Array.isArray(body) ? body : [body], as), 200, { "Content-Type": CONTENT_TYPE[as] });
    } catch (err) {
      const f = failure(err);
      return c.json({ error: f.error }, f.status);
    }
  };

  // Pages as markdown through the egress; capped by EXTRACT_PARALLEL, not the search queue.
  const extractRoute = async (c: Context<{ Bindings: HttpBindings }>, urls: string[], single: boolean, format?: string) => {
    let pages;
    try {
      pages = await extract(urls, c.req.raw.signal);
    } catch (err) {
      const f = failure(err);
      return c.json({ error: f.error }, f.status);
    }
    const as = pickFormat(format, c.req.header("Accept"));
    if (as === "json") return c.json(single ? pages[0]! : pages);
    return c.body(renderPages(pages, as), 200, { "Content-Type": CONTENT_TYPE[as] });
  };
  app.get("/extract", async (c) => {
    const parsed = extractQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]!.message }, 400);
    if (!parsed.data.url) return c.json({ error: "url is required" }, 400);
    return extractRoute(c, [parsed.data.url], true, parsed.data.format);
  });
  app.post("/extract", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "body is over 64 KB" }, 413) }), async (c) => {
    const format = formatSchema.safeParse(c.req.query("format"));
    if (!format.success) return c.json({ error: format.error.issues[0]!.message }, 400);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON: {url} or {urls: [...]}" }, 400);
    }
    const parsed = extractBodySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]!.message }, 400);
    const { url, urls } = parsed.data;
    return extractRoute(c, urls ?? [url!], url !== undefined, format.data);
  });

  app.get("/openapi.json", (c) => c.json(doc));
  app.get("/search.json", search);
  app.get("/search", search);

  // No browser, no network: classify and parse an HTML page the caller already has.
  app.post(
    "/parse",
    bodyLimit({ maxSize: PARSE_MAX_BYTES, onError: (c) => c.json({ error: "body is over 5 MB" }, 413) }),
    async (c) => {
      const parsed = parseQuerySchema.safeParse(c.req.query());
      if (!parsed.success) return c.json({ error: parsed.error.issues[0]!.message }, 400);
      const html = await c.req.text();
      const verdict = classify(html, parsed.data.url ?? "");
      const { goto_links: _g, ping_paths: _p, ...fields } = parseSerp(html, parsed.data.hl ?? cfg.DEFAULT_HL);
      return c.json({ page_verdict: verdict.kind, verdict_reason: verdict.reason, ...fields });
    },
  );

  app.get("/searches/:file", (c) => {
    const m = /^([0-9a-f]{32})\.json$/.exec(c.req.param("file"));
    const body = m ? archive.get(m[1]!) : undefined;
    if (!body) return c.json({ error: "no search with that id in the last hour" }, 404);
    return c.json(body);
  });

  app.notFound((c) => c.json({ error: "use /search.json?q=..., /extract?url=..., POST /parse, /searches/<id>.json, /openapi.json or /health" }, 404));

  return app;
}
