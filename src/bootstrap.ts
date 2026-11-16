// Shared startup for the HTTP server, CLI and MCP: pick the egress, build the searcher.
import { readEgressState } from "./egress/state.js";
import { EgressTunnel } from "./egress/tunnel.js";
import { createScraper } from "./scraper/index.js";
import { StubSearcher } from "./server/stub.js";
import type { Searcher } from "./types.js";

export interface Runtime {
  searcher: Searcher;
  /** True when a real scraper is behind `searcher` (false = stub). */
  live: boolean;
  close(): Promise<void>;
}

/** Logs go to stderr so stdout stays clean for CLI output and MCP JSON-RPC. */
export async function startRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  let tunnel: EgressTunnel | undefined;
  const egress = env.SCRAPER_PROXY ? undefined : readEgressState();
  if (egress) {
    tunnel = new EgressTunnel(egress);
    env = { ...env, SCRAPER_PROXY: (await tunnel.start()).url };
    console.error(`egress: cloudflare, ${egress.workers.length} workers`);
  }
  if (!env.SCRAPER_PROXY) {
    console.error("no egress: run `npm run egress:up` or set SCRAPER_PROXY; using the stub searcher (every search returns an Error record)");
    return { searcher: new StubSearcher(), live: false, close: async () => { await tunnel?.close(); } };
  }
  const made = createScraper(env);
  console.error(`scraper: ${made.describe}`);
  return {
    searcher: made.scraper,
    live: true,
    close: async () => {
      await Promise.allSettled([made.scraper.close(), tunnel?.close()]);
    },
  };
}
