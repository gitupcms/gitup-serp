# gitup-serp

A self-hosted Google SERP scraper. It is written in TypeScript and serves its API with [Hono](https://hono.dev). Google traffic leaves through your own Cloudflare Workers (`worker/`, `src/egress/`) instead of a paid residential proxy.

Status: early. See [YAPILACAKLAR.md](YAPILACAKLAR.md) for what is done and what is left.

## Quick start

```bash
npm install
npm run setup                 # Chromium (.browsers/) + curl-impersonate (bin/)
cp .env.example .env          # CF_API_TOKEN, CF_ACCOUNT_ID (or SCRAPER_PROXY for any HTTP proxy)
npm run egress:up -- 3        # deploy 3 egress Workers to your Cloudflare account
npm start                     # http://127.0.0.1:8080/search.json?q=hono
npm run egress:down           # remove the Workers
```

This needs a display, because Chromium runs headful. On a server, use Xvfb, or run it in Docker (below).

`npm run cli -- doctor` checks the setup offline. It never prints secret values.

### From npm

Linux x64 only (the curl-impersonate build is), Node 22.9 or newer. Run it in a directory holding your `.env`:

```bash
npm install -g @gitupcms/gitup-serp
gitup-serp setup              # Chromium + curl-impersonate, into the package directory
gitup-serp egress up 3        # also: egress down, egress ls
gitup-serp serve              # HTTP API; also: mcp, canary
gitup-serp search "hono framework"
gitup-serp doctor
```

With npx, for an MCP client: `claude mcp add gitup-serp -- npx -y @gitupcms/gitup-serp mcp`. The egress state lives in `.openserp/` in the current directory (`EGRESS_STATE_DIR` to move it).

## Cloudflare token

1. In the Cloudflare dashboard, go to **My Profile → API Tokens → Create Token** and pick the **Edit Cloudflare Workers** template.
2. Limit **Account Resources** to your account, then create the token.
3. Put the token in `.env` as `CF_API_TOKEN`. Put your account ID, from the right sidebar of the Workers & Pages page, in `CF_ACCOUNT_ID`.

`egress:up` creates a `workers.dev` subdomain if your account has none. Run `egress:ls` to see the deployed Workers and today's request count.

The free plan allows 100k Worker requests per day, and each tunnel connection counts as one. The local tunnel warns at 80% of `EGRESS_DAILY_LIMIT` and refuses new connections at 100%.

Two things are fixed by Cloudflare:
- The exit IP changes on every connection.
- You cannot choose the exit country.

Without `gl`, Google may answer in the language of the exit IP. Pass `hl` and `gl` when that matters.

## HTTP API

```bash
curl 'http://127.0.0.1:8080/search.json?q=hono&hl=en&gl=us'
curl -H "Authorization: Bearer $OPENSERP_API_KEY" 'http://host:8080/search.json?q=hono&pages=2&links=0'
curl 'http://127.0.0.1:8080/search.json?q=hono&async=true'   # returns an id right away
curl 'http://127.0.0.1:8080/searches/<id>.json'              # the result, kept for 1 hour
curl 'http://127.0.0.1:8080/search.json?q=hono&format=markdown&date=w'
curl -X POST -H 'Content-Type: text/html' --data-binary @page.html 'http://127.0.0.1:8080/parse?hl=en'
curl 'http://127.0.0.1:8080/extract?url=https://hono.dev/docs/&format=markdown'
curl -X POST -H 'Content-Type: application/json' -d '{"urls":["https://a.example/","https://b.example/"]}' 'http://127.0.0.1:8080/extract'
curl 'http://127.0.0.1:8080/search.json?q=hono&extract=3'   # the top 3 results' pages as markdown, too
curl 'http://127.0.0.1:8080/health'
```

Parameters:

| Parameter | Meaning |
| --- | --- |
| `q` | The query. Required. |
| `pages` | Number of pages, from 1 to `MAX_PAGES` (default 3). |
| `hl` | Interface language. Default `en`. |
| `gl` | Country code, such as `us`. |
| `location` | Location, sent to Google as uule. |
| `tbs`, `cr`, `lr` | Google's own filters. |
| `date` | Past `h`our, `d`ay, `w`eek, `m`onth or `y`ear, or a day range `YYYYMMDD..YYYYMMDD`. Sent as `tbs` (after any `tbs` you give). |
| `links` | How many result links to resolve. `0` turns it off and makes the query much faster. |
| `links_wait` | Seconds to wait for links (0-120); answers with what was resolved by then. |
| `extract` | 0-5 (default 0): also extract the first N organic results that have a link, and put each page under its result as `extracted: {markdown, title?, error?}`. Raises `links` to at least N. Runs after the cache, so a cached page gets fresh extraction. |
| `async` | `true` returns an id right away. |
| `format` | `json` (default), `markdown` or `text` (plain, compact for an LLM's context). Without it, `Accept: text/markdown` or `text/plain` picks the same. Every page in order when `pages` > 1. |

Every record has `search_metadata.timings`, in ms: `queue`, `fetch`, `browser`, `links`, `links_held`, `links_lookups`, `exits`, `retries` and `total`.

Successful pages are cached for `CACHE_TTL_S`. A cached page has a new `search_metadata.id` and `search_metadata.cached: true`. Single-page synchronous requests send `X-Cache: HIT` or `MISS`, and `/health` shows the cache size.

`POST /parse` classifies and parses an HTML page you already have, with no browser and no network: send the page as a `text/html` body (5 MB at most, 413 above), with optional `hl` (default `DEFAULT_HL`) and `url` (the page's final URL, for the verdict). It returns `page_verdict`, `verdict_reason` and the parsed blocks of a record. It has the same key and rate limit as `/search`.

`GET /extract?url=...` and `POST /extract` (JSON `{"url": ...}` or `{"urls": [...]}`, at most 20, duplicates dropped) return a page's main content as markdown: `{url, status, title?, description?, lang?, canonical?, markdown, text, error?}`, or an array of them for `urls`. A page that fails has empty `markdown` and the reason in `error`. `format=markdown|text` returns the body only, several pages under a heading per URL. Extractions do not wait in the search queue; at most `EXTRACT_PARALLEL` run at once. Same key and rate limit as `/search`.

Extraction goes through the same egress as the search (Cloudflare Workers or `SCRAPER_PROXY`), never from this machine's own address; without an egress every page fails with `no egress`. Workers cannot open TCP connections to Cloudflare-hosted sites, so over the Cloudflare egress those pages are fetched with the Worker's own `fetch()` instead (`via: "worker-fetch"`; otherwise `"tunnel"`, or `"proxy"` with `SCRAPER_PROXY`). Origins then see a Cloudflare address and a `CF-Worker` header naming your workers.dev subdomain. That request's TLS fingerprint is Cloudflare's, not Chrome's, so some sites may refuse it. With `SCRAPER_PROXY` there is no such fallback: a refused page fails with `target refused by the proxy`. Every extraction hop (each redirect, and the `fetch()` retry) counts against the Workers daily request quota (`EGRESS_DAILY_LIMIT`). HTML only: no JavaScript rendering, no PDF.

Pass the key as `Authorization: Bearer`; `?api_key=` is refused. Binding to anything other than loopback requires `OPENSERP_API_KEY`.

`GET /openapi.json` serves an OpenAPI 3.1 document for these routes: the parameters with their limits, the record shape and the error responses. It needs no key but counts against the rate limit.

## CLI

```bash
npm run cli -- search "hono framework" --pages 2 --format csv --output out.csv
npm run cli -- search --input queries.txt --output out.jsonl --resume
npm run cli -- search "hono framework" --date m --format markdown
npm run cli -- search "hono framework" --extract 3 --format markdown
npm run cli -- extract https://hono.dev/docs/ https://a.example/ --format json
```

`--date` takes the API's `date` values; `--format` is `jsonl` (default), `json`, `csv` or `markdown`. `--extract N` (0-5) works as the API's `extract`. `extract` prints pages as markdown (default) or JSON, through the egress as in the API, and exits 1 when a page failed.

`npm link` puts the same CLI on your PATH as `gitup-serp`.

## Canary

```bash
npm run canary                      # needs egress (npm run egress:up or SCRAPER_PROXY)
npm run canary -- --save pages/     # keep the HTML of failing pages, to turn into a fixture
```

Six live queries: two commercial, `pizza near me`, `hono framework`, one Turkish and one Japanese. Each must come back with verdict `serp` and at least 5 organic results, and `pizza near me` with a local pack. Ads and AI Overview don't show every time, so ads need to appear on at least one of the two commercial queries, and AI Overview is only reported (`-` line), never a failure. Exit code: 0 all pass, 1 any fail, 2 no egress.

`.github/workflows/canary.yml` runs it daily and on demand when the `CF_API_TOKEN` and `CF_ACCOUNT_ID` secrets are set, skips otherwise, and uploads failing pages as an artifact.

## MCP

The MCP server talks JSON-RPC over stdio and exposes two tools: `google_search` (with `extract`, 0-5, as in the API) and `extract` (`url` or `urls`, at most 20), which returns the pages as markdown. Extraction goes through the egress, with the limits described under [HTTP API](#http-api).

Claude Code:

```bash
claude mcp add gitup-serp -- npm run -s --prefix /path/to/gitup-serp mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gitup-serp": { "command": "npm", "args": ["run", "-s", "--prefix", "/path/to/gitup-serp", "mcp"] }
  }
}
```

Run `npm run egress:up` first, or set `SCRAPER_PROXY` in `.env`.

## Settings

All optional, in `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEFAULT_GL`, `DEFAULT_HL` | `us`, `en` | Used when a query gives no `gl`/`hl`. Set `DEFAULT_GL=` to send none. |
| `POOL_SIZE` | 1 | Parallel browser identities. |
| `SPARE_IDENTITIES` | 1 | Warm identities kept ready to replace a refused one at once (one extra browser each). |
| `EGRESS_PREFIX` | `openserp-egress` | Worker name prefix; `egress:up`/`down` replace every Worker with it. |
| `PACE_MS` | 3000 | Minimum gap between any two Google result pages; grows 1.5x on each refusal (up to 60 s), shrinks after 20 served pages. 0 = off. |
| `BREAKER_COOLDOWN_S` | 300 | After 6 refused exits in a row, wait this long, then try one query; each failed try doubles it (up to 30 min). The CLI waits; the API answers `retry after N s`. |
| `FALLBACK_PROXY` | unset | Paid proxy (same format as `SCRAPER_PROXY`) used only while Google blocks the Cloudflare egress: refused queries retry on it once, and it serves until Cloudflare's breaker reopens. Starts on demand, keeps no spares. Records show `search_metadata.egress`. |
| `FALLBACK_IDLE_S` | 600 | Close the fallback's browsers after this many seconds without a fallback query. |
| `ENGINE_FALLBACK` | unset | `duckduckgo`: while Google refuses (after `FALLBACK_PROXY` too, when set), queries are answered by DuckDuckGo over the Cloudflare egress. These results come from DuckDuckGo (Bing-backed), not Google, and are marked `search_metadata.engine: "duckduckgo"`. Organic results, page 1 only (DuckDuckGo refuses a next-page request from a new IP, and the Cloudflare egress changes IP per request): no ads, local pack or AI overview. Cloudflare egress only. |
| `BROWSER_MAX_PAGES` | 50 | Restart the browser after this many pages (0 = never). |
| `EXIT_MAX_QUERIES` | 300 | Take a new exit session after this many queries (0 = never). |
| `TRUST_PROXY` | off | Rate-limit by the first `X-Forwarded-For` address. Only behind a proxy that overwrites that header. |
| `EGRESS_DAILY_LIMIT` | 100000 | Local cap on Worker requests per UTC day. |
| `LINK_PARALLEL`, `LINK_BUDGET_MS` | 4, 30000 | Link lookups at once per page, and the time a page's lookups may take in total. |
| `SAVE_HTML` | | Directory to save every fetched page in. |
| `CACHE_TTL_S` | 120 | Seconds a successful page stays cached, for the API, MCP and CLI alike. 0 = off. |
| `CACHE_MAX` | 1000 | Cached pages kept; the oldest goes first. |
| `EXTRACT_PARALLEL` | 3 | Page extractions at once (`/extract`, `extract=N`, MCP and CLI), through the egress. |

Without `location`, the `gl` country is sent as the location, so the local pack lands in that country (not the exit IP's). Pass `location` for a city.

## Docker

```bash
docker build -t gitup-serp .
docker run --rm --env-file .env -v gitup-serp-data:/data gitup-serp egress:up 3
docker run -d -p 8080:8080 --env-file .env -e OPENSERP_API_KEY=change-me -v gitup-serp-data:/data gitup-serp
docker run --rm -i --env-file .env -v gitup-serp-data:/data gitup-serp mcp
```

The `/data` volume keeps the egress state and the usage counter. The image is x86_64 only.

## Credits

- The scraping design, parser and classifier are ported from [nodemaven/serpmaven](https://github.com/nodemaven/serpmaven) (MIT, Copyright (c) 2026 NodeMaven).
- The idea of a Workers egress tunnel comes from [Michaelliv/flaregun](https://github.com/Michaelliv/flaregun) and [violet27chen/CFspider](https://github.com/violet27chen/CFspider). This repo contains none of their code.

Automated querying may violate Google's and Cloudflare's terms. You are responsible for how you use it.
