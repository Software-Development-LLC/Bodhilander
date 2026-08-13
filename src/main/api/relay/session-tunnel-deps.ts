/**
 * Production wiring for `SessionTunnel`.
 *
 * This is the only file that connects the tunnel to the singletons, and it
 * exists so `session-tunnel.ts` can import nothing from Electron. That split
 * is what makes the tunnel's deny branches testable: `mock.module()` is
 * process-wide in bun, so a test that stubbed `ptyManager` through the tunnel
 * would break `pty-manager.test.ts` depending on which file loaded first.
 *
 * Keep this module thin. Anything with a branch in it belongs on the other
 * side of the port, where it can be tested.
 */

import log from 'electron-log';
import { ptyManager } from '../../pty-manager';
import { getAllSessions } from '../../repositories/sessions';
import { getAllGroups } from '../../repositories/groups';
import { createRemoteSession, createRemoteGroup } from './remote-sessions';
import { ensureIdentity, signWithIdentity } from './relay-identity';
import * as grantStore from './grant-store';
import type { TunnelDeps, TunnelSessionRow, TunnelGroupRow } from './session-tunnel';

export function defaultDeps(relayOrigin: () => string, machineId: () => string | null): TunnelDeps {
  return {
    pty: {
      subscribe(handlers) {
        ptyManager.on('data', handlers.data);
        ptyManager.on('exit', handlers.exit);
        ptyManager.on('resize', handlers.resize);
        return () => {
          ptyManager.off('data', handlers.data);
          ptyManager.off('exit', handlers.exit);
          ptyManager.off('resize', handlers.resize);
        };
      },
      write: (id, data) => ptyManager.write(id, data),
      resize: (id, cols, rows) => ptyManager.resize(id, cols, rows),
      getSize: (id) => ptyManager.getSize(id),
      isLive: (id) => !!ptyManager.getSession(id),
      // `spawnedAt` is the PTY instance's identity: it changes on every
      // restart, which is exactly the staleness a session grant must notice.
      ptyEpoch: (id) => ptyManager.getSession(id)?.spawnedAt ?? null,
      getSerializedBuffer: (id) => ptyManager.getSerializedBuffer(id),
    },
    sessions: { getAll: () => getAllSessions() as unknown as TunnelSessionRow[] },
    groups: { getAll: () => getAllGroups() as unknown as TunnelGroupRow[] },
    grants: {
      get: (grantId) => grantStore.getGrant(grantId),
      ownerUserId: () => grantStore.getOwnerUserId(),
      enforced: () => grantStore.grantsEnforced(),
      latch: () => grantStore.latchGrantsEnforced(),
    },
    remote: {
      createSession: (spec) => createRemoteSession(spec),
      createGroup: (spec) => createRemoteGroup(spec),
    },
    identity: {
      ed25519Pub: () => ensureIdentity().ed25519Pub,
      sign: (message) => signWithIdentity(message),
    },
    log: {
      info: (msg, meta) => (meta === undefined ? log.info(msg) : log.info(msg, meta)),
      warn: (msg, meta) => (meta === undefined ? log.warn(msg) : log.warn(msg, meta)),
      error: (msg, meta) => (meta === undefined ? log.error(msg) : log.error(msg, meta)),
    },
    relayOrigin,
    machineId,
    now: () => Date.now(),
  };
}
