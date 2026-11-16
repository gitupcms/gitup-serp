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
| `links` | How many result links to resolve. `0` turns it off and makes the query much faster. |
| `links_wait` | Seconds to wait for links (0-120); answers with what was resolved by then. |
| `async` | `true` returns an id right away. |

Every record has `search_metadata.timings`, in ms: `queue`, `fetch`, `browser`, `links`, `links_held`, `links_lookups`, `exits`, `retries` and `total`.

Pass the key as `Authorization: Bearer`; `?api_key=` is refused. Binding to anything other than loopback requires `OPENSERP_API_KEY`.

`GET /openapi.json` serves an OpenAPI 3.1 document for these routes: the parameters with their limits, the record shape and the error responses. It needs no key but counts against the rate limit.

## CLI

```bash
npm run cli -- search "hono framework" --pages 2 --format csv --output out.csv
npm run cli -- search --input queries.txt --output out.jsonl --resume
```

`npm link` puts the same CLI on your PATH as `gitup-serp`.

## Canary

```bash
npm run canary                      # needs egress (npm run egress:up or SCRAPER_PROXY)
npm run canary -- --save pages/     # keep the HTML of failing pages, to turn into a fixture
```

Six live queries: two commercial, `pizza near me`, `hono framework`, one Turkish and one Japanese. Each must come back with verdict `serp` and at least 5 organic results, and `pizza near me` with a local pack. Ads and AI Overview don't show every time, so ads need to appear on at least one of the two commercial queries, and AI Overview is only reported (`-` line), never a failure. Exit code: 0 all pass, 1 any fail, 2 no egress.

`.github/workflows/canary.yml` runs it daily and on demand when the `CF_API_TOKEN` and `CF_ACCOUNT_ID` secrets are set, skips otherwise, and uploads failing pages as an artifact.

## MCP

The MCP server talks JSON-RPC over stdio and exposes one tool, `google_search`.

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
| `BROWSER_MAX_PAGES` | 50 | Restart the browser after this many pages (0 = never). |
| `EXIT_MAX_QUERIES` | 300 | Take a new exit session after this many queries (0 = never). |
| `TRUST_PROXY` | off | Rate-limit by the first `X-Forwarded-For` address. Only behind a proxy that overwrites that header. |
| `EGRESS_DAILY_LIMIT` | 100000 | Local cap on Worker requests per UTC day. |
| `LINK_PARALLEL`, `LINK_BUDGET_MS` | 4, 30000 | Link lookups at once per page, and the time a page's lookups may take in total. |
| `SAVE_HTML` | | Directory to save every fetched page in. |

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
