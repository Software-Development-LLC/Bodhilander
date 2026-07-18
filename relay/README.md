# Bodhilander Relay

Multi-tenant cloud relay for Bodhilander remote hosting. Lets a signed-in user
reach their desktop Bodhilander from a browser or phone when they're **off-LAN**,
without standing up their own tunnel.

> **Status: Milestone 1 (M1).** This is the service skeleton — config, logging,
> SQLite schema + migrations, a `/health` endpoint, and a `/ws` endpoint that
> upgrades and immediately closes `1013 not implemented`. Auth, machine linking,
> and the real relay protocol land in later milestones (see [Milestones](#milestones)).

## Runtime

- **[Bun](https://bun.sh) ≥ 1.1.** The relay runs TypeScript directly (no build
  step) and uses Bun's built-in SQLite (`bun:sqlite`) and HTTP/WebSocket server
  (`Bun.serve`). There are **no native modules to compile.**

## Develop

```bash
bun install
cp .env.example .env      # optional; sensible dev defaults apply without it
bun run dev               # watch mode on http://localhost:8080
bun test                  # unit tests
bun run typecheck         # tsc --noEmit
```

Quick check once it's running:

```bash
curl -s localhost:8080/health   # {"ok":true,"version":"0.1.0","uptime":...}
```

## Deploy (Docker)

Docker is the supported deployment path. The image is a single-stage `oven/bun`
build — no toolchain, no compile step.

```bash
docker compose up --build -d          # relay on http://localhost:${PORT:-8080}
docker compose logs -f relay
```

The container runs with `NODE_ENV=production`, so **`SESSION_SECRET` is
required** — the server refuses to start without it. Put it in `.env` next to
`docker-compose.yml`:

```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
```

SQLite lives on the `relay-data` named volume at `/data/relay.db`.

### TLS

TLS is **not** handled by this stack. Terminate TLS at whatever already fronts
the host — a cloud load balancer, an existing nginx, Cloudflare, etc. — and
proxy to the container's published port. When behind such a proxy set
`TRUST_PROXY=true` so `X-Forwarded-*` headers are honored.

## Configuration

All configuration is environment-driven; see [`.env.example`](./.env.example)
for the annotated list. Invalid values fail fast at startup; insecure dev
defaults emit a warning instead.

## Milestones

| Milestone | Scope |
| --------- | ----- |
| **M1** (this) | Service skeleton: config, logging, DB schema + migrations, `/health`, `/ws` stub. |
| **M2** | Account auth (sign-in) + machine linking via link codes. |
| **M3** | The live relay protocol — brokering a web/phone client ↔ desktop agent over `/ws`. |
| **M4+** | Hosted web client + web-push. |

The layout of the M1 schema (users, sessions, machines with keypairs, link
codes, push subscriptions) anticipates these; the tables exist but are unused
until their milestone.
```
