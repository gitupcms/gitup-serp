import { serve } from "@hono/node-server";
import { type Config, loadConfig } from "./config.js";
import { readEgressState } from "./egress/state.js";
import { EgressTunnel } from "./egress/tunnel.js";
import { createScraper, type Scraper } from "./scraper/index.js";
import { createApp } from "./server/app.js";
import { StubSearcher } from "./server/stub.js";
import type { Searcher } from "./types.js";

let cfg: Config;
let searcher: Searcher;
let scraper: Scraper | undefined;
let tunnel: EgressTunnel | undefined;
try {
  cfg = loadConfig();
  let env = process.env;
  const egress = env.SCRAPER_PROXY ? undefined : readEgressState();
  if (egress) {
    tunnel = new EgressTunnel(egress);
    env = { ...env, SCRAPER_PROXY: (await tunnel.start()).url };
    console.error(`egress: cloudflare, ${egress.workers.length} workers`);
  }
  if (env.SCRAPER_PROXY) {
    const made = createScraper(env);
    searcher = scraper = made.scraper;
    console.error(`scraper: ${made.describe}`);
  } else {
    searcher = new StubSearcher();
    console.error("SCRAPER_PROXY is not set: running the stub searcher, every search returns an Error record");
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const app = createApp(searcher, cfg);
const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: cfg.HOST }, (info) => {
  console.error(`listening on http://${cfg.HOST}:${info.port}/search.json?q=...`);
});

function shutdown(signal: string) {
  console.error(`${signal}: shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // Close browsers and remove temp profiles alongside; a pending search fails fast once closed.
  Promise.allSettled([closed, scraper?.close(), tunnel?.close()]).then(() => process.exit(0));
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
