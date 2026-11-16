# gitup-serp: headful Chromium on Xvfb, serving the HTTP API on port 8080.
#
#   docker build -t gitup-serp .
#   docker run --rm gitup-serp cli doctor
#   docker run --rm -p 8080:8080 -e OPENSERP_API_KEY=... -e CF_API_TOKEN=... -e CF_ACCOUNT_ID=... \
#       -v gitup-serp-data:/data gitup-serp
#
# HOST is 0.0.0.0, so the server refuses to start without OPENSERP_API_KEY (on purpose).

# Stage 1: dependencies and curl-impersonate; curl stays out of the final image.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# tsx is a devDependency but runs the app, so dev deps stay.
RUN npm ci
# Same release as `npm run setup`. shortcut: x86_64 only, add a TARGETARCH switch for arm64 builds.
RUN mkdir -p bin \
    && curl -fsSL https://github.com/lexiforest/curl-impersonate/releases/download/v2.3.2/curl-impersonate-v2.3.2.x86_64-linux-gnu.tar.gz \
       | tar -xz -C bin

FROM node:22-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.browsers \
    EGRESS_STATE_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        xvfb xauth tini ca-certificates \
        fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/bin ./bin
# Chromium plus its apt runtime deps (needs root, hence before USER).
RUN npx patchright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /app/.browsers
COPY . .
COPY docker/entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint \
    && mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint"]
CMD ["npm", "start"]
