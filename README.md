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

This needs a display, because Chromium runs headful. On a server, use Xvfb.

## Credits

- The scraping design, parser and classifier are ported from [nodemaven/serpmaven](https://github.com/nodemaven/serpmaven) (MIT, Copyright (c) 2026 NodeMaven).
- The idea of a Workers egress tunnel comes from [Michaelliv/flaregun](https://github.com/Michaelliv/flaregun) and [violet27chen/CFspider](https://github.com/violet27chen/CFspider). This repo contains none of their code.

Automated querying may violate Google's and Cloudflare's terms. You are responsible for how you use it.
