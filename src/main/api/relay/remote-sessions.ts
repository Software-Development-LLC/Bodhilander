/**
 * Create a terminal session on behalf of a remote web client (M3.4), going
 * through the app's real session path so a remotely-created session is
 * identical to one made on the desktop.
 *
 * This faithfully replicates the two IPC handlers the renderer drives:
 *   - persist + events + broadcast: `db:sessions:create` (src/main/index.ts)
 *   - spawn the PTY:               `pty:create`          (src/main/index.ts)
 * Kept in sync with those; if they change, update here too.
 */

import crypto from 'crypto';
import os from 'os';
import { EventEmitter } from 'events';
import log from 'electron-log';
import type { Session } from '../../../shared/types';
import * as sessionsRepo from '../../repositories/sessions';
import * as sessionEventsRepo from '../../repositories/session-events';
import * as groupsRepo from '../../repositories/groups';
import { ptyManager } from '../../pty-manager';
import { getApiServer } from '../index';
import { soundManager } from '../../sound-manager';
import { resolveLaunchProviderId } from '../../providers';

/** Emits 'created' (with the Session) when a session is created remotely, so
 *  the main process can tell the desktop renderer to refresh its list. */
export const remoteSessionEvents = new EventEmitter();

export interface CreateSessionOptions {
  groupId: string;
  name: string;
  /** A provider registry id (claude, codex, grok, opencode, kimi, cursor, antigravity). */
  provider: string;
  /** false → a plain shell session; true → launch the agent CLI. */
  launchClaude: boolean;
}

/** Resolve a group's working dir the way the renderer does: own → parent's → home. */
function resolveCwd(groupId: string): string {
  const groups = groupsRepo.getAllGroups();
  const group = groups.find((g) => g.id === groupId);
  const parentDir = group?.parentId ? groups.find((g) => g.id === group.parentId)?.workingDir : '';
  return group?.workingDir || parentDir || os.homedir();
}

export function createRemoteSession(opts: CreateSessionOptions): Session {
  const cwd = resolveCwd(opts.groupId);
  const id = crypto.randomUUID();
  const existing = sessionsRepo.getAllSessions();

  const session: Session = {
    id,
    groupId: opts.groupId,
    name: opts.name,
    workingDir: cwd,
    state: 'idle',
    shellType: opts.launchClaude ? 'claude' : 'bash',
    order: existing.filter((s) => s.groupId === opts.groupId).length,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    claudeSessionId: null,
    endedAt: null,
    durationSeconds: 0,
    claudeAccountId: null,
    provider: opts.provider,
  };

  // Step 1 — persist the row, log the start event, notify LAN clients.
  sessionsRepo.createSession(session);
  try {
    sessionEventsRepo.createEvent(session.id, 'session_start', null);
  } catch (err) {
    log.error('[Relay] session_start event failed:', err);
  }
  try {
    getApiServer().broadcastSessionsUpdated();
  } catch {
    // API server may not be running — non-fatal.
  }

  // Step 2 — spawn the PTY exactly as pty:create does.
  ptyManager.createSession(id, cwd, opts.launchClaude, opts.groupId, resolveLaunchProviderId(session.provider, opts.provider));
  try {
    soundManager.playStartSound();
  } catch {
    // Sound is best-effort.
  }

  log.info('[Relay] remote session created', { id, groupId: opts.groupId, provider: opts.provider, launchClaude: opts.launchClaude });
  remoteSessionEvents.emit('created', session);
  return session;
}
