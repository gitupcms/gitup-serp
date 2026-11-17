import { z } from "zod";

const int = (def: number) => z.coerce.number().int().min(1).default(def);

// hl/gl rules shared by the HTTP API, the CLI and MCP.
export const hlSchema = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$/, "hl must be a language code such as en or pt-BR");
export const glSchema = z.string().regex(/^[A-Za-z]{2}$/, "gl must be a two-letter country code such as us");
// links_wait in seconds, same rules in the HTTP API, the CLI and MCP.
export const LINKS_WAIT_MAX_S = 120;
const linksWaitRange = `links_wait must be between 0 and ${LINKS_WAIT_MAX_S}`;
export const linksWaitSchema = z
  .number({ error: "links_wait must be a number" })
  .min(0, linksWaitRange)
  .max(LINKS_WAIT_MAX_S, linksWaitRange);

// A page to extract, same rules in the HTTP API, the CLI and MCP.
export const httpUrlSchema = z
  .string({ error: "url must be an http(s) URL" })
  .trim()
  .max(2048, "url is too long")
  .refine((v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol), "url must be an http(s) URL");

// date filter, same rules in the HTTP API, the CLI and MCP: past hour/day/week/month/year or a day range.
const RANGE = /^(\d{4})(\d{2})(\d{2})\.\.(\d{4})(\d{2})(\d{2})$/;
const realDay = (y: string, m: string, d: string) => {
  const t = new Date(Date.UTC(+y, +m - 1, +d));
  return t.getUTCFullYear() === +y && t.getUTCMonth() === +m - 1 && t.getUTCDate() === +d;
};
export const dateSchema = z
  .string()
  .regex(/^([hdwmy]|\d{8}\.\.\d{8})$/, "date must be h, d, w, m, y or a range YYYYMMDD..YYYYMMDD")
  .refine((v) => {
    const r = RANGE.exec(v);
    return !r || (realDay(r[1]!, r[2]!, r[3]!) && realDay(r[4]!, r[5]!, r[6]!) && v.slice(0, 8) <= v.slice(10));
  }, "date range must be two real days YYYYMMDD..YYYYMMDD, the first not after the second");

/** Google's `tbs` for a validated `date`, after any `tbs` the caller gave: "d" → "qdr:d". */
export function dateTbs(date: string, tbs?: string): string {
  const r = RANGE.exec(date);
  const f = r ? `cdr:1,cd_min:${+r[2]!}/${+r[3]!}/${r[1]},cd_max:${+r[5]!}/${+r[6]!}/${r[4]}` : `qdr:${date}`;
  return tbs ? `${tbs},${f}` : f;
}

/** Exits sit in many countries; without a gl Google answers in the exit's language. `DEFAULT_GL=` turns it off. */
const defaultsSchema = z.object({
  DEFAULT_HL: z
    .string()
    .optional()
    .transform((v) => v || "en")
    .pipe(hlSchema),
  DEFAULT_GL: z
    .string()
    .default("us")
    .transform((v) => v || undefined)
    .pipe(glSchema.optional()),
});

export type SearchDefaults = { hl: string; gl?: string };

function parseEnv<T extends z.ZodType>(s: T, env: NodeJS.ProcessEnv): z.output<T> {
  const parsed = s.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid config: ${msg}`);
  }
  return parsed.data;
}

/** hl/gl applied when the caller gives none; throws on invalid DEFAULT_HL/DEFAULT_GL. */
export function searchDefaults(env: NodeJS.ProcessEnv = process.env): SearchDefaults {
  const d = parseEnv(defaultsSchema, env);
  return { hl: d.DEFAULT_HL, gl: d.DEFAULT_GL };
}

// Page extractions at once (API /extract, `extract=N`, MCP, CLI).
const extractSchema = z.object({ EXTRACT_PARALLEL: z.preprocess((v) => v || undefined, int(3)) });

/** EXTRACT_PARALLEL for MCP and the CLI; throws on an invalid value. */
export function extractParallel(env: NodeJS.ProcessEnv = process.env): number {
  return parseEnv(extractSchema, env).EXTRACT_PARALLEL;
}

const schema = defaultsSchema.extend({
  ...extractSchema.shape,
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  HOST: z.string().min(1).default("127.0.0.1"),
  OPENSERP_API_KEY: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  MAX_PAGES: int(3),
  MAX_CONCURRENCY: int(2),
  MAX_QUEUE: z.coerce.number().int().min(0).default(50),
  REQUEST_TIMEOUT_MS: int(120_000),
  RATE_PER_MIN: int(60),
  /** Key the rate limiter on the first X-Forwarded-For address; only behind a proxy that sets it. */
  TRUST_PROXY: z.preprocess((v) => v || undefined, z.stringbool().default(false)),
});

export type Config = z.output<typeof schema>;

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Read and validate the environment once; throws with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = parseEnv(schema, env);
  if (!cfg.OPENSERP_API_KEY && !isLoopback(cfg.HOST)) {
    throw new Error(
      "set OPENSERP_API_KEY before listening on a non-loopback address: " +
        "anyone who can reach the port spends your proxy traffic",
    );
  }
  return cfg;
}
