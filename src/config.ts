import { z } from "zod";

const int = (def: number) => z.coerce.number().int().min(1).default(def);

const schema = z.object({
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
});

export type Config = z.output<typeof schema>;

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Read and validate the environment once; throws with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid config: ${msg}`);
  }
  const cfg = parsed.data;
  if (!cfg.OPENSERP_API_KEY && !isLoopback(cfg.HOST)) {
    throw new Error(
      "set OPENSERP_API_KEY before listening on a non-loopback address: " +
        "anyone who can reach the port spends your proxy traffic",
    );
  }
  return cfg;
}
