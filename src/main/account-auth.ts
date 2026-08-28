/**
 * Account login-flow orchestration (BDHLNDR-31).
 *
 * Each registered account owns an isolated CLAUDE_CONFIG_DIR under
 * <userData>/claude-accounts/<id>/.claude. This module creates it, spawns an
 * in-app login pty against it, watches it for the artifacts that mean a login
 * landed, and tears all of it down on cancel or delete. What counts as such an
 * artifact is account-identity's to decide, not this module's.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import log from 'electron-log';
// Type-only: a value import would drag node-pty (a native module) into every
// process that loads this file, including the test runner.
import type { PtyManager } from './pty-manager';
import * as accountsRepo from './repositories/accounts';
import { AccountIdentity, LOGIN_ARTIFACTS, resolveAccountIdentity } from './account-identity';
import { registerHooks } from './mcp-config';
import { seedLegacyConversations } from './legacy-claude-seed';
import { ClaudeAccount } from '../shared/types';

interface LoginFlow {
  accountId: string;
  ptyId: string;
  configDir: string;
  watcher: fs.FSWatcher | null;
  completed: boolean;
  exitListener: (event: { id: string; exitCode: number }) => void;
}

const activeFlows = new Map<string, LoginFlow>();

/**
 * Swatch colours handed to new accounts, in order (#165). The same family the
 * sidebar offers for groups, so the two kinds of dot look like one system.
 */
const ACCOUNT_COLORS = [
  '#61afef', '#98c379', '#c678dd', '#e5c07b', '#56b6c2', '#e06c75',
];

export interface StartLoginResult {
  account: ClaudeAccount;
  ptyId: string;
}

function accountRoot(accountId: string): string {
  return path.join(app.getPath('userData'), 'claude-accounts', accountId);
}

function configDirFor(accountId: string): string {
  return path.join(accountRoot(accountId), '.claude');
}

/**
 * Begin an interactive login flow for a new account.
 * Returns the new account row + the login pty id the renderer should attach to.
 */
export async function startLoginFlow(
  ptyManager: PtyManager,
  mainWindow: BrowserWindow | null,
  label: string,
): Promise<StartLoginResult> {
  const accountId = crypto.randomUUID();
  const configDir = configDirFor(accountId);
  fs.mkdirSync(configDir, { recursive: true });

  // First account becomes the default fallback. The check and the insert
  // stay synchronous — no await between them — so two overlapping
  // startLoginFlow calls can't both observe "no accounts yet" and both
  // become the default.
  const existing = accountsRepo.getAllAccounts();
  const isFirst = existing.length === 0;
  const account = accountsRepo.createAccount({
    id: accountId,
    label,
    configDir,
    // Give the swatch something to say (#165). Every account used to take the
    // repository's #888888 fallback, because nothing ever passed a colour and
    // no UI can change one — so the dot the header, the sidebar and the
    // accounts panel all draw was the same grey on every row, occupying space
    // in a header where space is scarce and identifying nothing. Cycling the
    // palette by account count keeps consecutive logins distinct, which is the
    // case that matters; the label still carries the identity on its own, so
    // this is decoration that has finally earned its place rather than a
    // channel anything depends on.
    color: ACCOUNT_COLORS[existing.length % ACCOUNT_COLORS.length],
    isDefault: isFirst,
  });

  // Becoming the default re-homes every unassigned session's
  // CLAUDE_CONFIG_DIR here on its next launch. Seed the dir with the legacy
  // ~/.claude transcripts so those sessions' stored --resume UUIDs keep
  // resolving instead of coming back "No conversation found" (pre-accounts
  // history lives in ~/.claude). Awaited before the login pty spawns: the
  // account only becomes reachable for session launches once the user logs
  // in, so finishing the copy first avoids resumes against a half-seeded
  // dir. Subsequent accounts are separate identities and inherit nothing.
  if (isFirst) {
    await seedLegacyConversations(configDir);
  }

  // Register the Bodhilander MCP server + hooks into the new account's
  // isolated config before spawning the login pty, so the session has them
  // available from the first turn (BDHLNDR-31).
  try {
    registerHooks(configDir);
  } catch (err) {
    log.warn(`[Accounts] Hook registration failed for new account ${accountId}:`, err);
  }

  const ptyId = beginLoginPty(ptyManager, mainWindow, accountId, configDir, () => {
    // Roll back the account row + directory if we couldn't spawn the pty.
    // Only a login that MINTED the account may do this — see `resumeLoginFlow`.
    try {
      accountsRepo.deleteAccount(accountId);
      fs.rmSync(accountRoot(accountId), { recursive: true, force: true });
    } catch (cleanupErr) {
      log.error(`[Accounts] Cleanup after failed login spawn failed for ${accountId}:`, cleanupErr);
    }
  });

  log.info(`[Accounts] Started login flow for account ${accountId} (label="${label}", ptyId=${ptyId})`);

  return { account, ptyId };
}

/**
 * Sign in to an account that already exists — the case a restore creates.
 *
 * A restored `claude_accounts` row arrives with its label, its colour and its
 * place in the failover order, and with no credentials: those live in the
 * source machine's keychain and were never in the bundle. Everything about the
 * login is the same as a new account's; what must NOT be the same is the
 * rollback. `startLoginFlow` deletes the row and its directory when the pty
 * will not spawn, which is right for an account it minted a moment ago and
 * catastrophic for one the user has had for months.
 */
export function resumeLoginFlow(
  ptyManager: PtyManager,
  mainWindow: BrowserWindow | null,
  accountId: string,
): StartLoginResult {
  const account = accountsRepo.getAccount(accountId);
  if (!account) throw new Error(`No such account: ${accountId}`);

  // The restore rewrites `config_dir` to this machine's accounts root, but the
  // directory itself only exists once something writes to it.
  fs.mkdirSync(account.configDir, { recursive: true });
  try {
    registerHooks(account.configDir);
  } catch (err) {
    log.warn(`[Accounts] Hook registration failed for ${accountId}:`, err);
  }

  // No rollback: the account is the user's, and a pty that would not spawn is
  // a reason to report a failure, never to delete it.
  const ptyId = beginLoginPty(ptyManager, mainWindow, accountId, account.configDir);

  log.info(`[Accounts] Resumed login flow for existing account ${accountId} (ptyId=${ptyId})`);
  return { account, ptyId };
}

/**
 * Spawn the login pty for `accountId` against `configDir` and watch it for the
 * artifacts that mean a login landed. Shared by the two entry points so a new
 * account and a restored one complete by exactly the same evidence.
 *
 * `onSpawnFailure` runs before the error is rethrown, and exists only so the
 * caller that created the account can undo that.
 */
function beginLoginPty(
  ptyManager: PtyManager,
  mainWindow: BrowserWindow | null,
  accountId: string,
  configDir: string,
  onSpawnFailure?: () => void,
): string {
  const ptyId = `__login-${accountId}`;

  try {
    ptyManager.createLoginSession(ptyId, configDir);
  } catch (err) {
    onSpawnFailure?.();
    throw err;
  }

  const watcher = fs.watch(configDir, (_eventType, filename) => {
    if (!filename) return;
    if (!LOGIN_ARTIFACTS.has(filename.toString())) return;
    const flow = activeFlows.get(ptyId);
    if (!flow || flow.completed) return;
    // .claude.json is written from the first run onward, so the write itself
    // is not the signal — only what the file says once it lands.
    const identity = resolveAccountIdentity(configDir);
    if (!identity.loggedIn) return;
    flow.completed = true;
    // Hand on what we just read: a re-read here can catch the next rewrite
    // mid-flight and under-report the login we came in holding.
    handleLoginCompleted(ptyId, mainWindow, identity);
  });

  const exitListener = (event: { id: string; exitCode: number }) => {
    if (event.id !== ptyId) return;
    const flow = activeFlows.get(ptyId);
    if (flow && !flow.completed) {
      log.warn(`[Accounts] Login pty ${ptyId} exited (code ${event.exitCode}) before credentials appeared`);
      flow.watcher?.close();
      mainWindow?.webContents.send('accounts:login-exited', { accountId: flow.accountId, exitCode: event.exitCode });
    }
    ptyManager.off('exit', exitListener);
    activeFlows.delete(ptyId);
  };
  ptyManager.on('exit', exitListener);

  activeFlows.set(ptyId, {
    accountId,
    ptyId,
    configDir,
    watcher,
    completed: false,
    exitListener,
  });

  return ptyId;
}

function handleLoginCompleted(
  ptyId: string,
  mainWindow: BrowserWindow | null,
  known?: AccountIdentity,
): void {
  const flow = activeFlows.get(ptyId);
  if (!flow) return;

  const { email, loggedIn } = known ?? resolveAccountIdentity(flow.configDir);
  accountsRepo.updateAccount(flow.accountId, { email });

  // `verified` separates a login the config dir showed us from one the user
  // asserted with a button, so the renderer never claims more than we know.
  mainWindow?.webContents.send('accounts:login-completed', {
    accountId: flow.accountId,
    email,
    verified: loggedIn === true,
  });
  log.info(`[Accounts] Login completed for ${flow.accountId}${email ? ` (${email})` : ''}`);
}

/**
 * The macOS button's override, for a login the watcher did not catch: a Claude
 * version that records the profile somewhere new, or writes the watch missed.
 * Emits the same event the watched path does, so the renderer sees one story.
 */
export function confirmLoginMacOS(
  mainWindow: BrowserWindow | null,
  ptyId: string,
): void {
  const flow = activeFlows.get(ptyId);
  if (!flow || flow.completed) return;
  flow.completed = true;
  handleLoginCompleted(ptyId, mainWindow);
}

/**
 * Cancel an in-progress login flow. If `deleteAccount` is true (user aborted
 * before completing login), the account row and its config directory are
 * removed. If false (user is just closing the modal after success), the
 * account is kept.
 */
export function cancelLoginFlow(
  ptyManager: PtyManager,
  ptyId: string,
  deleteAccount: boolean,
): void {
  const flow = activeFlows.get(ptyId);
  if (!flow) return;

  flow.watcher?.close();
  ptyManager.off('exit', flow.exitListener);
  // Best-effort: a pty that already exited resolves cleanly, so a rejection
  // means teardown itself glitched — and with the flow being discarded either
  // way, that is worth a log line, not a failed cancel.
  ptyManager.kill(ptyId).catch((err) => {
    log.warn(`[Accounts] Failed to kill login pty ${ptyId}:`, err);
  });

  if (deleteAccount) {
    try {
      accountsRepo.deleteAccount(flow.accountId);
      fs.rmSync(accountRoot(flow.accountId), { recursive: true, force: true });
    } catch (err) {
      log.error(`[Accounts] Failed to clean up cancelled login for ${flow.accountId}:`, err);
    }
  }

  activeFlows.delete(ptyId);
}

/**
 * Delete an account and its on-disk config directory. Referring sessions and
 * groups are NULL-ed out by the repository layer.
 */
export function deleteAccountAndDir(accountId: string): void {
  const account = accountsRepo.getAccount(accountId);
  if (!account) return;

  accountsRepo.deleteAccount(accountId);

  try {
    const root = accountRoot(accountId);
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } catch (err) {
    log.error(`[Accounts] Failed to remove config dir for ${accountId}:`, err);
  }
}
