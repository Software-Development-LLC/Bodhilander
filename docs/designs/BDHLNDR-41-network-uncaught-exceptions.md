# BDHLNDR-41 — Unhandled network errors crash/destabilize main process

## Problem (from gregory's v3.3.0 `main.log`)

Two recurring `[Main] Uncaught exception` classes, caught only by the global
`process.on('uncaughtException')` logger (which leaves the process in an
undefined state):

- **mDNS ×32:** `send ENETUNREACH 224.0.0.251:5353` (`node:dgram`).
- **Relay:** `getaddrinfo ENOTFOUND cl-relay.sytanek.tech`.

## Root causes

1. **mDNS** (`api/discovery/mdns-advertiser.ts`): uses `bonjour-service`, which
   wraps a `multicast-dns` dgram socket. Transient send failures (sleep/wake,
   Wi-Fi switch, VPN, no route to the multicast group) are emitted on the
   **underlying mdns instance/socket**, which has no `'error'` listener →
   escapes to `uncaughtException`. The existing `service.on('error')` only
   catches Service-level errors (e.g. name-in-use), not socket send errors.
2. **Relay** (`api/relay/relay-connection.ts`): the `ws.on('error')` handler
   does `this.emit('error', error)`. `RelayConnection extends EventEmitter`;
   emitting `'error'` with **no registered `'error'` listener re-throws** as an
   uncaught exception (Node EventEmitter semantics). So a DNS failure that *was*
   handled by the ws error handler is converted into an uncaught exception.

## Fix

1. **mDNS** — `attachMdnsErrorHandler(bonjour)`: reach
   `(bonjour as any)._server.mdns` (internal to bonjour-service but stable
   across 1.x; optional-chained so a shape change degrades to today's behavior,
   no regression) and attach an `'error'` listener on the mdns instance and its
   `.socket`. Classify transient network codes
   (`ENETUNREACH/ENETDOWN/EHOSTUNREACH/EHOSTDOWN/ENODEV/EADDRNOTAVAIL/EPERM`)
   as expected — log at `warn` and swallow. mDNS is best-effort; bonjour
   re-announces periodically and self-heals when the network returns. Applied
   to both `MdnsAdvertiser.advertise()` and `MdnsDiscovery.start()`.
2. **Relay** — guard the re-emit: `if (this.listenerCount('error') > 0)
   this.emit('error', error)`; downgrade the log to `warn` (transient).
   Reconnect is already handled by the `'close'` handler that follows a failed
   ws connection (ws emits `'error'` then `'close'`), so no extra reconnect
   logic is needed — the only defect is the unguarded re-emit.
3. **Global handler** (`index.ts`) — audited. It is a non-exiting logger of
   last resort; correct to keep. With (1)+(2) owning these errors at source it
   no longer sees the mDNS/relay floods. No behavior change (a comment records
   the audit). Changing it to relaunch/exit is out of scope.

## Acceptance mapping

- AC1 (no `[Main] Uncaught exception` for mDNS/relay on Wi-Fi off/on,
  sleep/wake, offline): addressed by (1)+(2). Empirical network-toggle
  verification is manual (no test framework — documented project deviation).
- AC2 (auto-recover when network returns): bonjour periodic re-announce +
  relay `scheduleReconnect` already self-heal once the crashes stop.
- AC3 (global handler no longer logs those): consequence of (1)+(2).

## Verification

`build:main` (tsc) green; logic trace of the offline → reconnect paths.
Empirical: toggle Wi-Fi / sleep-wake on a packaged build → expect zero new
`[Main] Uncaught exception` mDNS/relay lines (manual, pre-merge or on beta).
