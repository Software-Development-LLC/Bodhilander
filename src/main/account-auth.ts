/**
 * Account login-flow orchestration (BDHLNDR-31).
 *
 * Each registered Claude account owns an isolated CLAUDE_CONFIG_DIR under
 * <userData>/claude-accounts/<id>/.claude. This module:
 *   1. Creates that directory and inserts the account row.
 *   2. Spawns an in-app login pty running `claude` with CLAUDE_CONFIG_DIR set.
 *   3. Watches for the credentials file to appear (Linux/Windows) and parses
 *      the account email for display.
 *   4. Cleans up the pty, watcher, row, and directory on cancel/delete.
 *
 * macOS note: Claude Code stores tokens in Keychain rather than a plain file
 * when running on macOS, so the watcher will not fire for the OAuth-login
 * path. The renderer must let the user confirm "I'm logged in" manually on
 * macOS; the pty exit alone isn't sufficient evidence.
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

  const ptyId = `__login-${accountId}`;

  try {
    ptyManager.createLoginSession(ptyId, configDir);
  } catch (err) {
    // Roll back the account row + directory if we couldn't spawn the pty.
    try {
      accountsRepo.deleteAccount(accountId);
      fs.rmSync(accountRoot(accountId), { recursive: true, force: true });
    } catch (cleanupErr) {
      log.error(`[Accounts] Cleanup after failed login spawn failed for ${accountId}:`, cleanupErr);
    }
    throw err;
  }

  const watcher = fs.watch(configDir, (_eventType, filename) => {
    if (!filename) return;
    const name = filename.toString();
    if (name === '.credentials.json' || name === 'auth.json') {
      const flow = activeFlows.get(ptyId);
      if (flow && !flow.completed) {
        flow.completed = true;
        handleLoginCompleted(ptyId, mainWindow);
      }
    }
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

  log.info(`[Accounts] Started login flow for account ${accountId} (label="${label}", ptyId=${ptyId})`);

  return { account, ptyId };
}

function handleLoginCompleted(ptyId: string, mainWindow: BrowserWindow | null): void {
  const flow = activeFlows.get(ptyId);
  if (!flow) return;

  const email = parseAccountEmail(flow.configDir);
  accountsRepo.updateAccount(flow.accountId, { email });

  mainWindow?.webContents.send('accounts:login-completed', {
    accountId: flow.accountId,
    email,
  });
  log.info(`[Accounts] Login completed for ${flow.accountId}${email ? ` (${email})` : ''}`);
}

/**
 * Best-effort parse of the logged-in account's email from the credentials file.
 * Shapes vary across Claude Code versions, so we check several common paths
 * and silently return null if none match.
 */
function parseAccountEmail(configDir: string): string | null {
  try {
    const credsPath = path.join(configDir, '.credentials.json');
    if (!fs.existsSync(credsPath)) return null;
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    return (
      creds?.claudeAiOauth?.subscriptionEmail ??
      creds?.claudeAiOauth?.email ??
      creds?.account?.email ??
      creds?.email ??
      null
    );
  } catch (err) {
    log.warn('[Accounts] Failed to parse credentials for email:', err);
    return null;
  }
}

/**
 * Called when the user confirms macOS login manually (where the credentials
 * file doesn't appear because Keychain is used instead). Marks the flow
 * completed and emits the same event as the file watcher path.
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
