# Bodhilander Relay

Multi-tenant cloud relay for Bodhilander remote hosting. Lets a signed-in user
reach their desktop Bodhilander from a browser or phone when they're **off-LAN**,
without standing up their own tunnel.

The service is live and feature-complete for its current scope: GitHub OAuth
sign-in (with an optional org gate), machine linking, the end-to-end-encrypted
relay tunnel, session sharing, rate limiting, and a mobile-first web client.
See [What's implemented](#whats-implemented).

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
curl -s localhost:8080/health   # {"ok":true,"version":"...","uptime":...}
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

## What's implemented

**Auth & linking**
- GitHub OAuth sign-in (`/auth/github/login` → `/auth/github/callback`), cookie
  sessions, `POST /auth/logout`. `ALLOWED_GITHUB_ORG` optionally gates sign-in
  to org members.
- Machine linking: the desktop agent registers over `POST /link` with an
  Ed25519 signature and gets a short link code; the signed-in user claims it
  via `POST /link/claim` (or from the web client).

**The tunnel**
- `/ws` (agents) and `/ws/client` (browsers). Agents authenticate by signing a
  server nonce with their machine key; browser clients authenticate with the
  session cookie at upgrade time.
- The relay is a **blind router**: client↔agent frames carry an opaque payload
  the relay forwards without reading. Terminal traffic is end-to-end encrypted
  between the browser and the desktop (X25519 ECDH → HKDF-SHA256 →
  AES-256-GCM, fresh ephemeral keys per channel, an Ed25519 handshake proof
  against MITM, and a fingerprint shown in the web client for verification).

**Session sharing**
- Owners mint single-use invites, signed by the machine key (a stolen relay
  session cannot mint invites). Invites can be addressed to a specific GitHub
  login — enforced at redemption — or left open.
- Grants are session-scoped (the relay never learns session ids) and either
  time-boxed or valid until revoked. The protocol defines `viewer` and
  `operator` roles, but only watch-only (`viewer`) grants are offered today.
  Every join still requires the owner's explicit approval on the desktop.
- Access certificates are Ed25519-signed by the machine and bound to the relay
  origin, so a certificate minted against one relay is useless on another.

**Web client** (`web/`)
- A dependency-light TypeScript SPA ("Bodhilander Remote") served by the relay:
  GitHub sign-in, machine list, session list with live state, a full xterm
  terminal, session/group creation, invite redemption at `/i/:code`, and a
  watch-only mode for guests. Mobile-first: the phone's screen size drives the
  PTY dimensions.

**Operational**
- Fixed-window rate limiting per IP (and per machine key for `/link`),
  `/health`, structured logging, SQLite schema + migrations, and a periodic
  reaper for expired sessions, link codes, invites, and grants.

**Not implemented:** web push from the relay. (Push notifications exist only on
the desktop app's LAN path.)

Design history lives in
[`docs/designs/remote-hosting-relay.md`](../docs/designs/remote-hosting-relay.md)
and [`docs/designs/session-sharing.md`](../docs/designs/session-sharing.md).
