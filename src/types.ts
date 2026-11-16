// Shared contract between server, scraper and parser. Shape follows serpmaven's output.py (MIT).

export type VerdictKind = "serp" | "sorry" | "wall" | "block" | "consent" | "no_js" | "empty" | "unknown";

export interface Verdict {
  kind: VerdictKind;
  reason: string;
}

export interface SearchParams {
  q: string;
  page: number; // 1-based
  hl: string;
  gl?: string;
  location?: string;
  tbs?: string;
  cr?: string;
  lr?: string;
  /** Organic results whose `/goto` link is resolved, from the top: default all, 0 = off. */
  links?: number;
}

export interface SerpRecord {
  search_metadata: {
    id: string;
    status: "Success" | "Error" | "Processing";
    created_at: string;
    total_time_taken: number;
    google_url: string | null;
    page_verdict: VerdictKind | null;
    verdict_reason: string | null;
  };
  search_parameters: SearchParams & { engine: "google"; device: "desktop" };
  exit?: Record<string, unknown>;
  error?: string;
  // Parsed fields (organic_results, ads, ...) are merged in by src/parse.
  [field: string]: unknown;
}

/** What the HTTP layer needs from the scraping core. One call = one results page. */
export interface Searcher {
  search(params: SearchParams, signal?: AbortSignal): Promise<SerpRecord>;
  health(): { state: "ok" | "warming" | "busy" | "down"; [k: string]: unknown };
}
