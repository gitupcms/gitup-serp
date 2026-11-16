// Shared startup for the HTTP server, CLI and MCP: pick the egress, build the searcher.
import { readEgressState } from "./egress/state.js";
import { EgressTunnel } from "./egress/tunnel.js";
import { z } from "zod";
import { FailoverSearcher, FALLBACK_IDLE_S } from "./scraper/failover.js";
import { createScraper } from "./scraper/index.js";
import { ProxyTemplate } from "./scraper/proxy.js";
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
  let searcher: Searcher & { close(): Promise<void> } = made.scraper;
  if (tunnel && env.FALLBACK_PROXY) {
    const fallbackProxy = env.FALLBACK_PROXY;
    let proxy: ProxyTemplate;
    try {
      proxy = new ProxyTemplate(fallbackProxy); // a bad URL fails at startup, not on the first blocked query
    } catch (err) {
      throw new Error(`FALLBACK_PROXY: ${(err as Error).message}`);
    }
    const idle = z.coerce.number().min(1).default(FALLBACK_IDLE_S).safeParse(env.FALLBACK_IDLE_S || undefined);
    if (!idle.success) throw new Error(`invalid config: FALLBACK_IDLE_S: ${idle.error.issues[0]?.message}`);
    // Each spare is a paid warm-up, so the fallback keeps none.
    const fallbackEnv = { ...env, SCRAPER_PROXY: fallbackProxy, SPARE_IDENTITIES: "0" };
    searcher = new FailoverSearcher(made.scraper, () => createScraper(fallbackEnv).scraper, idle.data * 1000);
    console.error(`fallback: ${proxy.describe()}, starts on demand`);
  }
  return {
    searcher,
    live: true,
    close: async () => {
      await Promise.allSettled([searcher.close(), tunnel?.close()]);
    },
  };
}
