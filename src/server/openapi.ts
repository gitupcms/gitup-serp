// GET /openapi.json: the query parameters come from the route's own zod schema, so they can't drift.
import { z } from "zod";

const error = { type: "object", required: ["error"], properties: { error: { type: "string" } } };
const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const timings = {
  type: "object",
  description: "Milliseconds per phase of this page; only the phases that happened.",
  properties: {
    queue: { type: "integer" },
    fetch: { type: "integer" },
    browser: { type: "integer" },
    links: { type: "integer" },
    links_held: { type: "integer" },
    links_lookups: { type: "integer" },
    exits: { type: "integer" },
    retries: { type: "array", items: { type: "string" } },
    total: { type: "integer" },
  },
  required: ["total"],
};

const record = {
  type: "object",
  description: "One results page. Parsed blocks are empty, not absent, when the page had none.",
  required: ["search_metadata", "search_parameters"],
  properties: {
    search_metadata: {
      type: "object",
      required: ["id", "status", "created_at", "total_time_taken", "google_url", "page_verdict", "verdict_reason"],
      properties: {
        id: { type: "string", pattern: "^[0-9a-f]{32}$" },
        status: { type: "string", enum: ["Success", "Error", "Processing"] },
        created_at: { type: "string", format: "date-time" },
        total_time_taken: { type: "number" },
        google_url: { type: ["string", "null"] },
        page_verdict: {
          type: ["string", "null"],
          enum: ["serp", "sorry", "wall", "block", "consent", "no_js", "empty", "unknown", null],
        },
        verdict_reason: { type: ["string", "null"] },
        timings,
        cached: { type: "boolean", description: "Served from the result cache (CACHE_TTL_S)." },
      },
    },
    search_parameters: { type: "object", additionalProperties: true },
    error: { type: "string" },
    search_information: { type: "object", additionalProperties: true },
    ads: { type: "array", items: { type: "object", additionalProperties: true } },
    organic_results: { type: "array", items: { type: "object", additionalProperties: true } },
    related_questions: { type: "array", items: { type: "object", additionalProperties: true } },
    related_searches: { type: "array", items: { type: "object", additionalProperties: true } },
    pagination: { type: "object", additionalProperties: true },
    ai_overview: { type: "object", additionalProperties: true },
    local_results: { type: "array", items: { type: "object", additionalProperties: true } },
  },
  additionalProperties: true,
};

const pending = {
  type: "object",
  description: "An async search still running, or one that failed.",
  required: ["search_metadata"],
  properties: {
    search_metadata: {
      type: "object",
      required: ["id", "status"],
      properties: { id: { type: "string" }, status: { type: "string", enum: ["Processing", "Error"] } },
    },
    error: { type: "string" },
    via: { type: "string", enum: ["tunnel", "worker-fetch", "proxy"], description: "Which path served the page: the Cloudflare tunnel, a Worker's fetch() (Cloudflare-hosted sites), or SCRAPER_PROXY." },
  },
};

const extracted = {
  type: "object",
  description:
    "One page's main content. Fetched through the search egress (Cloudflare Workers or SCRAPER_PROXY), HTML only: " +
    "no JavaScript rendering, no PDF. A failure is in `error`, with empty markdown and text.",
  required: ["url", "status", "markdown", "text"],
  properties: {
    url: { type: "string", description: "The final URL, after redirects." },
    status: { type: ["integer", "null"] },
    title: { type: "string" },
    description: { type: "string" },
    lang: { type: "string" },
    canonical: { type: "string" },
    markdown: { type: "string" },
    text: { type: "string" },
    error: { type: "string" },
    via: { type: "string", enum: ["tunnel", "worker-fetch", "proxy"], description: "Which path served the page: the Cloudflare tunnel, a Worker's fetch() (Cloudflare-hosted sites), or SCRAPER_PROXY." },
  },
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });

export function openapiDoc(query: z.ZodObject) {
  // Output side for the limits (a pipe's checks live there), input side for what is required.
  const out = z.toJSONSchema(query, { io: "output", unrepresentable: "any" }) as {
    properties: Record<string, Record<string, unknown>>;
  };
  const required = new Set(
    (z.toJSONSchema(query, { io: "input", unrepresentable: "any" }) as { required?: string[] }).required ?? [],
  );
  const parameters = Object.entries(out.properties).map(([name, schema]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema,
  }));

  const searchOp = {
    summary: "Search Google; one record per page (an array when pages > 1).",
    parameters,
    responses: {
      200: {
        description:
          "A record, an array of records (pages > 1), or with async=true a Processing stub. With format=markdown|text " +
          "(or Accept: text/markdown / text/plain and no format), every page rendered as text.",
        headers: { "X-Cache": { schema: { type: "string", enum: ["HIT", "MISS"] }, description: "Single-page synchronous requests." } },
        content: {
          ...json({ oneOf: [ref("Record"), { type: "array", items: ref("Record") }, ref("Pending")] }),
          "text/markdown": { schema: { type: "string" } },
          "text/plain": { schema: { type: "string" } },
        },
      },
      400: errorResponse("Invalid parameter, or ?api_key= used instead of the Authorization header."),
      401: errorResponse("Missing or wrong API key."),
      429: {
        ...errorResponse("Rate limit exceeded or queue full."),
        headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds, on the rate limit." } },
      },
      500: errorResponse("Scraper failure."),
      504: errorResponse("The search took longer than REQUEST_TIMEOUT_MS."),
    },
  };

  const extractResponses = {
    200: {
      description:
        "The page (an array for urls). With format=markdown|text (or the Accept header), the body as text; several pages " +
        "under a heading per URL.",
      content: {
        ...json({ oneOf: [ref("Extracted"), { type: "array", items: ref("Extracted") }] }),
        "text/markdown": { schema: { type: "string" } },
        "text/plain": { schema: { type: "string" } },
      },
    },
    400: errorResponse("Not an http(s) URL, more than 20 URLs, or an invalid parameter."),
    401: errorResponse("Missing or wrong API key."),
    429: errorResponse("Rate limit exceeded."),
  };

  return {
    openapi: "3.1.0",
    info: { title: "gitup-serp", version: "1" },
    security: [{ bearer: [] }],
    paths: {
      "/search.json": { get: searchOp },
      "/extract": {
        get: {
          summary: "One web page's main content as markdown, through the search egress. Not queued with searches.",
          parameters: [
            { name: "url", in: "query", required: true, schema: { type: "string", format: "uri", maxLength: 2048 }, description: "An http(s) URL." },
            { name: "format", in: "query", required: false, schema: { type: "string", enum: ["json", "markdown", "text"] } },
          ],
          responses: extractResponses,
        },
        post: {
          summary: "One or several pages (at most 20, duplicates dropped); {url} answers one object, {urls} an array.",
          parameters: [{ name: "format", in: "query", required: false, schema: { type: "string", enum: ["json", "markdown", "text"] } }],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              properties: {
                url: { type: "string", format: "uri" },
                urls: { type: "array", items: { type: "string", format: "uri" }, minItems: 1, maxItems: 20 },
              },
              oneOf: [{ required: ["url"] }, { required: ["urls"] }],
            }),
          },
          responses: { ...extractResponses, 413: errorResponse("Body over 64 KB.") },
        },
      },
      "/parse": {
        post: {
          summary: "Classify and parse a Google results page you already have. No browser, no network.",
          parameters: [
            { name: "hl", in: "query", required: false, schema: { type: "string" }, description: "Page language; default DEFAULT_HL." },
            { name: "url", in: "query", required: false, schema: { type: "string" }, description: "The page's final URL, for the verdict." },
          ],
          requestBody: { required: true, content: { "text/html": { schema: { type: "string", maxLength: 5 * 1024 * 1024 } } } },
          responses: {
            200: {
              description: "page_verdict, verdict_reason and the parsed blocks of a Record.",
              content: json({
                type: "object",
                required: ["page_verdict", "verdict_reason"],
                properties: {
                  page_verdict: record.properties.search_metadata.properties.page_verdict,
                  verdict_reason: { type: "string" },
                  ...Object.fromEntries(Object.entries(record.properties).filter(([k]) => !["search_metadata", "search_parameters", "error"].includes(k))),
                },
              }),
            },
            400: errorResponse("Invalid parameter."),
            401: errorResponse("Missing or wrong API key."),
            413: errorResponse("Body over 5 MB."),
            429: errorResponse("Rate limit exceeded."),
          },
        },
      },
      "/searches/{id}.json": {
        get: {
          summary: "A search from the last hour, by id (async results land here).",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[0-9a-f]{32}$" } }],
          responses: {
            200: { description: "The stored body.", content: json({ oneOf: [ref("Record"), { type: "array", items: ref("Record") }, ref("Pending")] }) },
            401: errorResponse("Missing or wrong API key."),
            404: errorResponse("No search with that id in the last hour."),
            429: errorResponse("Rate limit exceeded."),
          },
        },
      },
      "/health": {
        get: {
          summary: "Scraper state. No auth, no rate limit.",
          security: [],
          responses: {
            200: { description: "Ready.", content: json(ref("Health")) },
            503: { description: "Warming, busy or down.", content: json(ref("Health")) },
          },
        },
      },
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Only when OPENSERP_API_KEY is set." } },
      schemas: {
        Error: error,
        Record: record,
        Pending: pending,
        Extracted: extracted,
        Health: {
          type: "object",
          required: ["state"],
          properties: { state: { type: "string", enum: ["ok", "warming", "busy", "down"] } },
          additionalProperties: true,
        },
      },
    },
  };
}
