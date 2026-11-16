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
        description: "A record, an array of records (pages > 1), or with async=true a Processing stub.",
        content: json({ oneOf: [ref("Record"), { type: "array", items: ref("Record") }, ref("Pending")] }),
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

  return {
    openapi: "3.1.0",
    info: { title: "gitup-serp", version: "1" },
    security: [{ bearer: [] }],
    paths: {
      "/search.json": { get: searchOp },
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
