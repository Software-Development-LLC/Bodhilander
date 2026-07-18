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
the host — a cloud load balancer, an existing nginx, Caddy, Cloudflare, etc. —
and proxy to the container's published port. When behind such a proxy set
`TRUST_PROXY=true` so `X-Forwarded-*` headers are honored.

## Production deployment (reference: Caddy + Docker)

The live relay runs on a VM behind **Caddy** (which handles TLS via Let's
Encrypt, WebSocket upgrades, and `X-Forwarded-*` automatically). Recorded here
so it's reproducible. Substitute your own host/domain.

**1. DNS** — point the subdomain at the VM (`A` record → VM IP).

**2. Env** — `/root/bodhi-relay/.env` (production; `NODE_ENV=production` is baked
into the image):

```ini
PUBLIC_URL=https://relay.example.com
TRUST_PROXY=true
SESSION_SECRET=<openssl rand -hex 32>
GITHUB_CLIENT_ID=<oauth app client id>
GITHUB_CLIENT_SECRET=<oauth app client secret>
ALLOWED_GITHUB_ORG=Your-Org        # optional: gate sign-in to org members
```

The GitHub OAuth app's callback URL must be `${PUBLIC_URL}/auth/github/callback`.

**3. Build & run** — the compose file uses Compose v2 `env_file` syntax; if the
host only has Compose v1, use plain `docker`:

```bash
docker build -t bodhi-relay:latest .
docker run -d --name bodhi-relay --restart unless-stopped \
  -p 127.0.0.1:47393:8080 \
  -v bodhi-relay-data:/data \
  --env-file /root/bodhi-relay/.env \
  bodhi-relay:latest
```

Binding to `127.0.0.1` keeps the plain-HTTP relay off the network — only the
local Caddy reaches it.

**4. Caddy** — add a site block and reload (`systemctl reload caddy`):

```caddyfile
relay.example.com {
	reverse_proxy 127.0.0.1:47393
}
```

**Updating** — `--env-file` and the image are read at `docker run` time, so
after changing code or `.env` you must **rebuild and recreate** (a plain
`docker restart` does NOT pick up `.env` changes):

```bash
rsync -az --delete --exclude node_modules --exclude data --exclude .env \
  relay/ host:/root/bodhi-relay/
ssh host 'cd /root/bodhi-relay && docker build -t bodhi-relay:latest . \
  && docker rm -f bodhi-relay \
  && docker run -d --name bodhi-relay --restart unless-stopped \
       -p 127.0.0.1:47393:8080 -v bodhi-relay-data:/data \
       --env-file /root/bodhi-relay/.env bodhi-relay:latest'
```

The SQLite DB lives on the `bodhi-relay-data` volume, so linked machines survive
rebuilds.

## Configuration

All configuration is environment-driven; see [`.env.example`](./.env.example)
for the annotated list. Invalid values fail fast at startup; insecure dev
defaults emit a warning instead.

## Milestones

| Milestone | Scope | Status |
| --------- | ----- | ------ |
| **M1** | Service skeleton: config, logging, DB schema + migrations, `/health`, `/ws`. | ✅ done |
| **M2** | GitHub OAuth sign-in (+ optional org gate), machine linking via link codes, agent WS challenge/response presence, minimal web client. | ✅ done |
| **M3** | The live relay protocol — brokering a web/phone client ↔ desktop agent over `/ws` (E2E ciphertext). | next |
| **M4+** | Full web client (terminal view) + web-push. | planned |

The layout of the M1 schema (users, sessions, machines with keypairs, link
codes, push subscriptions) anticipates these; the tables exist but are unused
until their milestone.
```
