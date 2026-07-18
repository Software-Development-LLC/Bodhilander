# syntax=docker/dockerfile:1
#
# Single-stage Bun image. Bun runs the server TypeScript directly (no build
# step) and ships a built-in SQLite (`bun:sqlite`); the web client is bundled
# from web/ into web/dist during the build.

FROM oven/bun:1-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/relay.db
WORKDIR /app

RUN mkdir -p /data && chown bun:bun /data

# Install production deps against the committed lockfile for reproducibility.
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun tsconfig.json ./
# Bundle the web client (xterm.js + the SPA) into web/dist.
COPY --chown=bun:bun web ./web
RUN bun run build:web
COPY --chown=bun:bun src ./src

USER bun
VOLUME /data
EXPOSE 8080

# Self-contained healthcheck — uses the Bun runtime already in the image rather
# than assuming a wget/curl is present on the base.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e 'fetch("http://127.0.0.1:8080/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

CMD ["bun", "run", "src/index.ts"]
