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
curl -s localhost:8080/health   # {"ok":true,"version":"...","commit":null,"uptime":...}
```

## Deploy (Docker)

Docker is the supported deployment path. The image is a single-stage `oven/bun`
build — no toolchain, no compile step.

```bash
COMMIT=$(git rev-parse --short HEAD)$([ -n "$(git status --porcelain relay)" ] && echo -dirty)
RELAY_COMMIT=$COMMIT docker compose up --build -d
docker compose logs -f relay          # relay on http://localhost:${PORT:-8080}
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

**2. Env** — `/home/bodhilabs/bodhi-relay/.env` (production; `NODE_ENV=production`
is baked into the image):

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
docker build --build-arg RELAY_COMMIT=<source commit> -t bodhi-relay:latest .
docker run -d --name bodhi-relay --restart unless-stopped \
  -p 127.0.0.1:47393:8080 \
  -v bodhi-relay-data:/data \
  --env-file /home/bodhilabs/bodhi-relay/.env \
  bodhi-relay:latest
```

`RELAY_COMMIT` is what `/health` reports back (see [Identifying a
deployment](#identifying-a-deployment)). The host directory is an rsync target
rather than a checkout, so the value has to come from the machine you deploy
from — nothing on the host can derive it.

Binding to `127.0.0.1` keeps the plain-HTTP relay off the network — only the
local Caddy reaches it. That is what makes `TRUST_PROXY=true` safe: with it on,
the rate limiter buckets callers by the **rightmost** `X-Forwarded-For` entry,
trusting that exactly one proxy — Caddy — sits in front. Publish the port on a
routable address and anyone reaching it directly writes that entry themselves,
minting a fresh bucket per request and evading every limit, including the ones
guarding link codes.

**4. Caddy** — add a site block and reload (`systemctl reload caddy`):

```caddyfile
relay.example.com {
	reverse_proxy 127.0.0.1:47393
}
```

**Updating** — `--env-file` and the image are read at `docker run` time, so
after changing code or `.env` you must **rebuild and recreate** (a plain
`docker restart` does NOT pick up `.env` changes).

Run this from the repo root — `$COMMIT` is read from your checkout, and the
double quotes around the `ssh` argument are what expand it locally rather than
on the host. `rsync` ships the working tree rather than the commit, so the
`-dirty` suffix is what keeps the stamp from naming code that is not the code
being deployed:

```bash
COMMIT=$(git rev-parse --short HEAD)$([ -n "$(git status --porcelain relay)" ] && echo -dirty)
rsync -az --delete --exclude node_modules --exclude data --exclude .env \
  relay/ host:/home/bodhilabs/bodhi-relay/
ssh host "cd /home/bodhilabs/bodhi-relay \
  && docker build --build-arg RELAY_COMMIT=$COMMIT -t bodhi-relay:latest . \
  && docker rm -f bodhi-relay \
  && docker run -d --name bodhi-relay --restart unless-stopped \
       -p 127.0.0.1:47393:8080 -v bodhi-relay-data:/data \
       --env-file /home/bodhilabs/bodhi-relay/.env bodhi-relay:latest"
```

The SQLite DB lives on the `bodhi-relay-data` volume, so linked machines survive
rebuilds.

### Identifying a deployment

`/health` reports the build, so confirming what is live is one request:

```bash
curl -s https://relay.example.com/health
# {"ok":true,"version":"0.1.0","commit":"7d5cb5d","uptime":628551.3}
```

`version` is the `package.json` version and moves rarely, so it cannot tell two
builds apart; `commit` is the answer. It is `null` on an image built without
`RELAY_COMMIT`, and **absent entirely** on one built before `/health` carried
it — which is itself a useful thing to see. A `-dirty` suffix means the tree
that was shipped had uncommitted changes, so the sha names its parent rather
than what is running.

The same value is on the `relay listening` line at startup, which is where to
look when the container is crash-looping and there is nothing to `curl`:

```bash
docker logs bodhi-relay | head -1
```

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
  time-boxed or valid until revoked — restarting the shared session also ends
  the share. The protocol defines `viewer` and
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
