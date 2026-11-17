// Shared startup for the HTTP server, CLI and MCP: pick the egress, build the searcher.
import { readEgressState } from "./egress/state.js";
import { EgressTunnel } from "./egress/tunnel.js";
import type { FetchVia } from "./extract/index.js";
import { z } from "zod";
import { CachingSearcher } from "./scraper/cache.js";
import { DdgSearcher } from "./scraper/ddg.js";
import { FailoverSearcher, FALLBACK_IDLE_S } from "./scraper/failover.js";
import { createScraper } from "./scraper/index.js";
import { ProxyTemplate } from "./scraper/proxy.js";
import { StubSearcher } from "./server/stub.js";
import type { Searcher } from "./types.js";

export interface Runtime {
  searcher: Searcher;
  /** True when a real scraper is behind `searcher` (false = stub). */
  live: boolean;
  /** The egress proxy URL page extraction goes through (the tunnel or SCRAPER_PROXY); unset without egress. */
  egressProxy?: string;
  /** Set only with the Cloudflare tunnel: a Worker's fetch(), the extraction fallback for sites the tunnel refuses. */
  fetchVia?: FetchVia;
  close(): Promise<void>;
}

/** Logs go to stderr so stdout stays clean for CLI output and MCP JSON-RPC. */
export async function startRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const engineFallback = env.ENGINE_FALLBACK || undefined;
  if (engineFallback && engineFallback !== "duckduckgo") throw new Error(`invalid config: ENGINE_FALLBACK: only "duckduckgo", got "${engineFallback}"`);
  let tunnel: EgressTunnel | undefined;
  const egress = env.SCRAPER_PROXY ? undefined : readEgressState();
  if (egress) {
    tunnel = new EgressTunnel(egress);
    env = { ...env, SCRAPER_PROXY: (await tunnel.start()).url };
    console.error(`egress: cloudflare, ${egress.workers.length} workers`);
  }
  if (!env.SCRAPER_PROXY) {
    console.error("no egress: run `npm run egress:up` (`gitup-serp egress up`) or set SCRAPER_PROXY; using the stub searcher (every search returns an Error record)");
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
  if (engineFallback && tunnel) {
    // Last in line: after the residential fallback too, when that is set.
    const ddg = DdgSearcher.over(new ProxyTemplate(env.SCRAPER_PROXY).forSession(""));
    searcher = new FailoverSearcher(searcher, () => ddg);
    console.error("engine fallback: duckduckgo, only while Google refuses");
  } else if (engineFallback) console.error("ENGINE_FALLBACK ignored: it needs the Cloudflare egress, not SCRAPER_PROXY");
  const cache = z
    .object({ CACHE_TTL_S: z.coerce.number().min(0).default(120), CACHE_MAX: z.coerce.number().int().min(1).default(1000) })
    .safeParse({ CACHE_TTL_S: env.CACHE_TTL_S || undefined, CACHE_MAX: env.CACHE_MAX || undefined });
  if (!cache.success) {
    const i = cache.error.issues[0]!;
    throw new Error(`invalid config: ${i.path.join(".")}: ${i.message}`);
  }
  if (cache.data.CACHE_TTL_S > 0) searcher = new CachingSearcher(searcher, cache.data.CACHE_TTL_S * 1000, cache.data.CACHE_MAX);
  return {
    searcher,
    live: true,
    egressProxy: env.SCRAPER_PROXY,
    fetchVia: tunnel ? (url, headers, signal) => tunnel.fetchVia(url, headers, signal) : undefined,
    close: async () => {
      await Promise.allSettled([searcher.close(), tunnel?.close()]);
    },
  };
}
