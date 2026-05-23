/**
 * PWA-local copies of shared domain types (BDHLNDR-55).
 *
 * The canonical definitions live in `src/shared/types.ts`, but the PWA
 * tsconfig pins `rootDir` to `src/pwa`, and the shared module transitively
 * pulls in Electron types (via repositories etc.) — importing from outside
 * `rootDir` would either fail compilation or bloat the bundle with
 * Node/Electron-only declarations.
 *
 * We therefore redefine the narrow subset the PWA actually consumes over
 * the wire (REST + WS payloads). Keep these in sync with the server-side
 * `Session` / `Group` shapes; any new field used by the PWA needs adding
 * here too.
 *
 * Note on `Date` vs `string`: the server JSON-encodes `Date` values to ISO
 * strings, so over the wire these fields arrive as strings. We type them
 * as `string` here to match runtime reality — the PWA doesn't need
 * millisecond-level date math on these.
 */

export type SessionState =
  | 'idle'
  | 'working'
  | 'waiting'
  | 'error'
  | 'stopped';

export interface Session {
  id: string;
  groupId: string;
  name: string;
  workingDir: string;
  state: SessionState;
  shellType: string;
  order: number;
  createdAt: string;
  lastActivityAt: string;
  claudeSessionId: string | null;
  endedAt: string | null;
  durationSeconds: number;
  claudeAccountId: string | null;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  workingDir: string;
  order: number;
  createdAt: string;
  parentId: string | null;
  collapsed: boolean;
  claudeAccountId: string | null;
}
