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
  /** Seconds to wait for links; what is unresolved then stays null. Default: the link budget only. */
  links_wait?: number;
}

/** Integer milliseconds per phase of one results page, summed over the exits tried. */
export interface Timings {
  /** Waiting for a free identity, warm-up included. */
  queue?: number;
  /** The HTTP tries. */
  fetch?: number;
  /** Browser navigation. */
  browser?: number;
  /** Link resolution in all, its summed held waits and its lookup count. */
  links?: number;
  links_held?: number;
  links_lookups?: number;
  exits?: number;
  /** Waiting for the global pace between results requests; only when it held the query. */
  pace?: number;
  /** Why each dropped exit was dropped: a refusal verdict, "poisoned" or "error". */
  retries?: string[];
  total: number;
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
    /** Where this page's time went; only the phases that happened. */
    timings?: Timings;
    /** Which egress served it, when a fallback proxy is set (`FALLBACK_PROXY`). */
    egress?: "cloudflare" | "fallback";
    /** Which search engine served it; unset means Google. "duckduckgo" only with `ENGINE_FALLBACK`. */
    engine?: "google" | "duckduckgo";
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
