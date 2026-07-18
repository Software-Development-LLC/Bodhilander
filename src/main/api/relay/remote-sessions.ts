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
import type { Session, Group } from '../../../shared/types';
import * as sessionsRepo from '../../repositories/sessions';
import * as sessionEventsRepo from '../../repositories/session-events';
import * as groupsRepo from '../../repositories/groups';
import { ptyManager } from '../../pty-manager';
import { getApiServer } from '../index';
import { soundManager } from '../../sound-manager';
import { resolveLaunchProviderId } from '../../providers';

/** Emits 'created' (Session) / 'groupsChanged' when sessions or groups are
 *  created remotely, so the main process can refresh the desktop renderer. */
export const remoteSessionEvents = new EventEmitter();

export interface CreateGroupOptions {
  name: string;
  parentId: string | null;
  workingDir: string;
  color: string;
}

/** Create a group/subgroup on behalf of a remote web client. */
export function createRemoteGroup(opts: CreateGroupOptions): Group {
  const groups = groupsRepo.getAllGroups();
  const siblings = groups.filter((g) => (g.parentId ?? null) === (opts.parentId ?? null));
  const group: Group = {
    id: crypto.randomUUID(),
    name: opts.name.trim() || 'Group',
    color: opts.color || '#35c2d1',
    workingDir: opts.workingDir || '',
    order: siblings.length,
    createdAt: new Date(),
    parentId: opts.parentId ?? null,
    collapsed: false,
    claudeAccountId: null,
  };
  groupsRepo.createGroup(group);
  log.info('[Relay] remote group created', { id: group.id, name: group.name, parentId: group.parentId });
  remoteSessionEvents.emit('groupsChanged');
  return group;
}

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
  // An empty workingDir is the "inherit" sentinel, so fall through on falsy
  // (not just nullish) — own dir, then parent's, then home.
  if (group?.workingDir) return group.workingDir;
  if (group?.parentId) {
    const parent = groups.find((g) => g.id === group.parentId);
    if (parent?.workingDir) return parent.workingDir;
  }
  return os.homedir();
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
