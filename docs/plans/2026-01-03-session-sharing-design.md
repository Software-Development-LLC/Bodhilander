# Phase 2: Live Session Sharing Design

**Date:** 2026-01-03
**Status:** Approved
**Author:** Will Long II + Claude

---

## Overview

Enable real-time sharing of Claude Code sessions between users with E2E encryption. Users generate share codes (`SYCLX-XXXXXX`) with configurable permissions to invite others to view or control their sessions.

### Business Model

- **Free tier:** 1 active share, 2 viewers, 30 min limit, 2 codes per session
- **Pro tier:** $5/month - 5 shares, 10 viewers, unlimited duration, unlimited codes
- **Admin tier:** Unlimited everything (for developers/contributors)
- Self-hosting option: relay server is open source

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ClaudeLander App                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Session   │  │   Share     │  │   Account/Auth          │  │
│  │   Manager   │──│   Client    │──│   (OAuth + tier check)  │  │
│  └─────────────┘  └──────┬──────┘  └─────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────────┘
                           │ WebSocket (E2E encrypted)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Relay Server (api.sytanek.tech)               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐   │
│  │   Auth API  │  │   Session   │  │   Billing/Stripe        │   │
│  │  (GitHub)   │  │   Relay     │  │   (tier management)     │   │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                     PostgreSQL                              │ │
│  │   (users, sessions, share_codes, subscriptions)             │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. Host authenticates with GitHub OAuth → gets JWT
2. Host creates share code → server validates tier limits → returns `SYCLX-XXXXXX`
3. Guest enters code → server validates → establishes WebSocket to host
4. Terminal data flows: Host PTY → encrypt → relay → decrypt → Guest terminal
5. Guest input (if permitted): Guest → encrypt → relay → decrypt → Host PTY

---

## Share Codes & Permissions

### Code Format

```
SYCLX-XXXXXX
```
- `SYCLX` prefix for brand recognition
- 6 alphanumeric characters (36^6 = 2.1 billion combinations)
- Case-insensitive for easy verbal sharing

### Code Properties

```typescript
interface ShareCode {
  code: string;              // "SYCLX-A7X9K2"
  sessionId: string;         // links to local session
  hostUserId: string;        // owner
  permission: 'read' | 'control';
  maxUses: number | null;    // null = unlimited
  currentUses: number;
  expiresAt: Date | null;    // null = until session ends
  createdAt: Date;
  isActive: boolean;         // can be revoked
}
```

### Permission Levels

| Permission | Can View Terminal | Can Type/Send Input | Can Resize |
|------------|-------------------|---------------------|------------|
| `read`     | Yes               | No                  | No         |
| `control`  | Yes               | Yes                 | Yes        |

---

## E2E Encryption

### Scheme

- **Key Exchange:** X25519 (Elliptic Curve Diffie-Hellman)
- **Symmetric Encryption:** XChaCha20-Poly1305 (authenticated encryption)
- **Library:** libsodium via `sodium-native` npm package

### Flow

```
Host starts sharing:
1. Generate X25519 keypair (hostPublic, hostPrivate)
2. Store hostPrivate locally (never leaves device)
3. hostPublic sent to server, associated with share code

Guest joins:
1. Fetch hostPublic via share code
2. Generate ephemeral X25519 keypair (guestPublic, guestPrivate)
3. Derive shared secret: X25519(guestPrivate, hostPublic)
4. Send guestPublic to host (via relay)
5. Host derives same secret: X25519(hostPrivate, guestPublic)
6. Both sides now have identical shared secret

Data encryption:
- Use shared secret with XChaCha20-Poly1305
- Each message has unique nonce (counter-based)
- Relay sees only: { from, to, encryptedBlob, nonce }
```

### What's Encrypted

| Data | Encrypted? |
|------|------------|
| Terminal output | Yes |
| User input | Yes |
| Resize events | Yes |
| Share code validation | No (server needs to check) |
| User auth tokens | No (HTTPS is sufficient) |

### Trust Model

- Relay is "honest but curious" - routes correctly but might try to read data
- E2E means even a compromised relay cannot see session content
- Share codes are access tokens, not secret content

---

## Relay Server

### Tech Stack

- **Runtime:** Node.js
- **Framework:** NestJS
- **Database:** PostgreSQL
- **WebSockets:** @nestjs/websockets
- **Auth:** GitHub OAuth + JWT
- **Payments:** Stripe

### Project Structure

```
relay-server/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   ├── github.strategy.ts
│   │   └── jwt.guard.ts
│   ├── codes/
│   │   ├── codes.module.ts
│   │   ├── codes.controller.ts
│   │   └── codes.service.ts
│   ├── billing/
│   │   ├── billing.module.ts
│   │   ├── billing.controller.ts
│   │   └── billing.service.ts
│   ├── relay/
│   │   ├── relay.module.ts
│   │   ├── relay.gateway.ts
│   │   └── relay.service.ts
│   └── common/
│       ├── guards/
│       │   └── tier.guard.ts
│       └── entities/
│           └── *.entity.ts
├── Dockerfile
├── docker-compose.yml
└── package.json
```

### Database Schema

```sql
-- Users (from GitHub OAuth)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id BIGINT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  email TEXT,
  tier TEXT DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'admin')),
  stripe_customer_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Active share sessions
CREATE TABLE share_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_user_id UUID REFERENCES users(id),
  host_public_key TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

-- Share codes
CREATE TABLE share_codes (
  code TEXT PRIMARY KEY,
  session_id UUID REFERENCES share_sessions(id),
  permission TEXT NOT NULL CHECK (permission IN ('read', 'control')),
  max_uses INT,
  current_uses INT DEFAULT 0,
  expires_at TIMESTAMPTZ,
  revoked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Active connections (for presence/limits)
CREATE TABLE connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES share_sessions(id),
  user_id UUID REFERENCES users(id),
  code_used TEXT REFERENCES share_codes(code),
  connected_at TIMESTAMPTZ DEFAULT NOW()
);
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/github` | Start OAuth flow |
| GET | `/auth/github/callback` | OAuth callback → JWT |
| GET | `/auth/me` | Get current user + tier |
| POST | `/sessions` | Start sharing (host) |
| DELETE | `/sessions/:id` | Stop sharing |
| POST | `/sessions/:id/codes` | Generate share code |
| DELETE | `/codes/:code` | Revoke a code |
| GET | `/codes/:code/validate` | Check code validity |
| POST | `/billing/checkout` | Create Stripe checkout session |
| POST | `/billing/webhook` | Stripe webhook handler |
| POST | `/billing/portal` | Create billing portal session |
| WS | `/relay` | WebSocket for data relay |

### Tier Limits

```typescript
const TIER_LIMITS = {
  free:  { maxShares: 1, maxViewers: 2, maxDuration: 30 * 60, maxCodes: 2 },
  pro:   { maxShares: 5, maxViewers: 10, maxDuration: null, maxCodes: null },
  admin: { maxShares: null, maxViewers: null, maxDuration: null, maxCodes: null }
};
```

---

## Client-Side Integration

### New Modules

```
src/
├── main/
│   ├── sharing/
│   │   ├── share-manager.ts      # Orchestrates sharing
│   │   ├── crypto.ts             # E2E encryption (libsodium)
│   │   ├── relay-client.ts       # WebSocket to relay server
│   │   └── auth.ts               # OAuth flow + token storage
│   └── index.ts                  # New IPC handlers
├── renderer/
│   ├── components/
│   │   ├── ShareModal.tsx        # Generate/manage codes
│   │   ├── JoinSessionModal.tsx  # Enter code to join
│   │   ├── SharedSessionBadge.tsx
│   │   └── AccountMenu.tsx       # Login/tier status
│   └── store/
│       └── sharing.ts            # Sharing state hook
└── shared/
    └── types.ts                  # New sharing types
```

### IPC Handlers

```typescript
// Auth
'auth:login'           // Open GitHub OAuth in browser
'auth:logout'          // Clear tokens
'auth:getUser'         // Get current user + tier

// Sharing (host)
'share:start'          // Start sharing a session
'share:stop'           // Stop sharing
'share:createCode'     // Generate new code with options
'share:revokeCode'     // Revoke a code
'share:getActiveCodes' // List codes for a session

// Sharing (guest)
'share:join'           // Join with a code
'share:leave'          // Disconnect from shared session

// Events (main → renderer)
'share:guestJoined'    // Notify host of new guest
'share:guestLeft'      // Guest disconnected
'share:data'           // Incoming terminal data (guest)
'share:ended'          // Host stopped sharing
```

### UI Changes

| Location | Change |
|----------|--------|
| Session tab | "Share" button (when logged in) |
| Menu bar | "Join Session" option |
| System tray | Indicator when sharing active |
| Status bar | "Sharing: 2 viewers" or "SHARED" badge |
| Settings | Account tab (login, tier, billing link) |

---

## Deployment

### Infrastructure (api.sytanek.tech)

```
┌─────────────────────────────────────────────────────┐
│                    VPS (sytanek.tech)               │
│  ┌─────────────────────────────────────────────┐    │
│  │              Docker Compose                 │    │
│  │  ┌─────────────┐  ┌─────────────────────┐   │    │
│  │  │   relay     │  │     postgres        │   │    │
│  │  │   :3000     │  │      :5432          │   │    │
│  │  └──────┬──────┘  └─────────────────────┘   │    │
│  └─────────┼───────────────────────────────────┘    │
│            │                                        │
│  ┌─────────▼───────────────────────────────────┐    │
│  │                   Caddy                     │    │
│  │   - SSL termination (Let's Encrypt)         │    │
│  │   - Proxy to relay:3000                     │    │
│  │   - WebSocket upgrade handling              │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### docker-compose.yml

```yaml
version: '3.8'
services:
  relay:
    build: .
    restart: unless-stopped
    environment:
      - DATABASE_URL=postgresql://relay:${DB_PASSWORD}@postgres:5432/relay
      - GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
      - GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}
      - STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
      - STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      - postgres

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=relay
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=relay

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data

volumes:
  pgdata:
  caddy_data:
```

### Caddyfile

```
api.sytanek.tech {
    reverse_proxy relay:3000
}
```

### Backups

```bash
# Daily Postgres backup (cron)
0 3 * * * docker exec postgres pg_dump -U relay relay | gzip > /backups/relay-$(date +%Y%m%d).sql.gz
```

---

## Implementation Phases

### Phase 2.1: Relay Server MVP
- NestJS project setup
- GitHub OAuth
- PostgreSQL schema + migrations
- Share code CRUD
- WebSocket relay (no encryption yet)
- Docker + Caddy deployment

### Phase 2.2: E2E Encryption
- libsodium integration (client)
- Key exchange protocol
- Encrypted message relay
- Security testing

### Phase 2.3: Client Integration
- Share modal UI
- Join session UI
- Account/login UI
- IPC handlers
- State management

### Phase 2.4: Billing
- Stripe integration
- Tier enforcement
- Checkout flow
- Billing portal
- Admin tier

### Phase 2.5: Polish
- Error handling
- Reconnection logic
- Presence indicators
- Rate limiting
- Documentation

---

## Open Questions

None at this time.

---

## Appendix: Authentication Flow

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│  App    │     │ Browser │     │ Server  │     │ GitHub  │
└────┬────┘     └────┬────┘     └────┬────┘     └────┬────┘
     │               │               │               │
     │ Click Login   │               │               │
     ├──────────────>│               │               │
     │               │ GET /auth/github              │
     │               ├──────────────>│               │
     │               │               │ Redirect      │
     │               │<──────────────┤               │
     │               │ OAuth Flow    │               │
     │               ├──────────────────────────────>│
     │               │               │               │
     │               │ Callback + code               │
     │               │<──────────────────────────────┤
     │               │ GET /auth/github/callback     │
     │               ├──────────────>│               │
     │               │               │ Exchange code │
     │               │               ├──────────────>│
     │               │               │ User info     │
     │               │               │<──────────────┤
     │               │               │ Create JWT    │
     │               │ Redirect to app://auth?token=xxx
     │               │<──────────────┤               │
     │ Deep link     │               │               │
     │<──────────────┤               │               │
     │ Store token   │               │               │
     │               │               │               │
```
