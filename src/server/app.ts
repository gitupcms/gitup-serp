import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { z } from "zod";
import type { Config } from "../config.js";
import type { SearchParams, Searcher, SerpRecord } from "../types.js";
import { JobTimeoutError, Queue, QueueFullError } from "./queue.js";

const ARCHIVE_SIZE = 500;
const ARCHIVE_TTL_MS = 3_600_000;

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

function querySchema(maxPages: number) {
  return z.object({
    q: z.string({ error: "q is required" }).trim().min(1, "q is required").max(2048),
    pages: z.coerce
      .number({ error: "pages must be an integer" })
      .int("pages must be an integer")
      .min(1, `pages must be between 1 and ${maxPages}`)
      .max(maxPages, `pages must be between 1 and ${maxPages}`)
      .default(1),
    hl: z
      .string()
      .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$/, "hl must be a language code such as en or pt-BR")
      .default("en"),
    gl: z.string().regex(/^[A-Za-z]{2}$/, "gl must be a two-letter country code such as us").optional(),
    location: optional,
    tbs: optional,
    cr: optional,
    lr: optional,
    links: z.coerce
      .number({ error: "links must be an integer" })
      .int("links must be an integer")
      .min(0, "links must be 0 or more")
      .optional(),
    async: z.enum(["true", "false", "1", "0"], { error: "async must be true or false" }).optional(),
  });
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
) {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const queue = new Queue(cfg.MAX_CONCURRENCY, cfg.MAX_QUEUE, cfg.REQUEST_TIMEOUT_MS);
  const archive = new Archive();
  const limiter = new RateLimiter(cfg.RATE_PER_MIN);
  const schema = querySchema(cfg.MAX_PAGES);
  const keyHash = cfg.OPENSERP_API_KEY ? sha(cfg.OPENSERP_API_KEY) : undefined;

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
    // shortcut: keyed by socket address only (no X-Forwarded-For trust); behind a proxy all clients share one bucket.
    const ip = c.env?.incoming?.socket?.remoteAddress ?? "unknown";
    const wait = limiter.take(ip);
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    if (keyHash) {
      const header = c.req.header("Authorization") ?? "";
      const given = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!timingSafeEqual(sha(given), keyHash)) return c.json({ error: "missing or wrong API key" }, 401);
    }
    await next();
  });

  const search = async (c: Context<{ Bindings: HttpBindings }>) => {
    const parsed = schema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]!.message }, 400);
    const { pages, async: asyncFlag, ...rest } = parsed.data;
    const id = randomUUID().replaceAll("-", "");

    const job = (signal: AbortSignal) =>
      (async () => {
        const records: SerpRecord[] = [];
        for (let page = 1; page <= pages; page++) {
          const params: SearchParams = { ...rest, page };
          const r = await searcher.search(params, signal);
          records.push({ ...r, search_metadata: { ...r.search_metadata, id } });
        }
        return pages === 1 ? records[0]! : records;
      })();

    if (queue.full) return c.json({ error: "server is busy, try again later" }, 429);

    if (asyncFlag === "true" || asyncFlag === "1") {
      const processing = { search_metadata: { id, status: "Processing" as const } };
      archive.set(id, processing);
      queue.run(job).then(
        (body) => archive.set(id, body),
        (err) => archive.set(id, { search_metadata: { id, status: "Error" }, error: failure(err).error }),
      );
      return c.json(processing);
    }

    try {
      const body = await queue.run(job);
      archive.set(id, body);
      return c.json(body);
    } catch (err) {
      const f = failure(err);
      return c.json({ error: f.error }, f.status);
    }
  };

  app.get("/search.json", search);
  app.get("/search", search);

  app.get("/searches/:file", (c) => {
    const m = /^([0-9a-f]{32})\.json$/.exec(c.req.param("file"));
    const body = m ? archive.get(m[1]!) : undefined;
    if (!body) return c.json({ error: "no search with that id in the last hour" }, 404);
    return c.json(body);
  });

  app.notFound((c) => c.json({ error: "use /search.json?q=..., /searches/<id>.json or /health" }, 404));

  return app;
}
