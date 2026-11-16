import { randomUUID } from "node:crypto";
import type { SearchParams, Searcher, SerpRecord } from "../types.js";

/** Placeholder until the real scraper exists: every search is a well-formed Error record. */
export class StubSearcher implements Searcher {
  async search(params: SearchParams): Promise<SerpRecord> {
    return {
      search_metadata: {
        id: randomUUID().replaceAll("-", ""),
        status: "Error",
        created_at: new Date().toISOString(),
        total_time_taken: 0,
        google_url: null,
        page_verdict: null,
        verdict_reason: null,
      },
      search_parameters: { ...params, engine: "google", device: "desktop" },
      error: "scraper not wired yet",
    };
  }

  health() {
    return { state: "down" as const, reason: "scraper not wired yet" };
  }
}
