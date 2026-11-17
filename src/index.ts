import { serve } from "@hono/node-server";
import { startRuntime, type Runtime } from "./bootstrap.js";
import { type Config, loadConfig } from "./config.js";
import { extractor } from "./extract/attach.js";
import { egressHttp } from "./extract/index.js";
import { createApp } from "./server/app.js";

let cfg: Config;
let rt: Runtime;
try {
  cfg = loadConfig();
  rt = await startRuntime();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const app = createApp(rt.searcher, cfg, undefined, extractor(cfg.EXTRACT_PARALLEL, { http: egressHttp(rt.egressProxy, rt.fetchVia) }));
const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: cfg.HOST }, (info) => {
  console.error(`listening on http://${cfg.HOST}:${info.port}/search.json?q=...`);
});

function shutdown(signal: string) {
  console.error(`${signal}: shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // Close browsers and remove temp profiles alongside; a pending search fails fast once closed.
  Promise.allSettled([closed, rt.close()]).then(() => process.exit(0));
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
