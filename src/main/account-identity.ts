/**
 * Login evidence for one account's isolated CLAUDE_CONFIG_DIR. A token file
 * exists only where the OS has no secret store; .claude.json is written
 * everywhere, and gains an `oauthAccount` block at login.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ClaudeAccount } from '../shared/types';

export interface AccountIdentity {
  /** True on evidence of a login, false on none, undefined if unreadable. */
  loggedIn: boolean | undefined;
  /** The profile's address, when the artifact records one. */
  email: string | null;
}

const LOGGED_OUT: AccountIdentity = { loggedIn: false, email: null };
const UNKNOWN: AccountIdentity = { loggedIn: undefined, email: null };

/** The plaintext token stores, present only on platforms without a keyring. */
const CREDENTIAL_FILES = ['.credentials.json', 'auth.json'];

/** Every filename whose arrival or rewrite can mean a login just finished. */
export const LOGIN_ARTIFACTS: ReadonlySet<string> = new Set([
  ...CREDENTIAL_FILES,
  '.claude.json',
]);

/**
 * What one artifact had to say: an identity, nothing to say, or a file that is
 * there and unreadable — which is not the same as never having logged in.
 */
type Probe = AccountIdentity | 'absent' | 'unreadable';

/** Parsed contents, or undefined when the file cannot be read or parsed. */
function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

/**
 * A blank address identifies an account no better than a missing one, and the
 * value can arrive with the file's trailing newline still attached.
 */
function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

interface ProfileFile {
  oauthAccount?: { emailAddress?: unknown; email?: unknown; accountUuid?: unknown };
}

interface TokenFile {
  claudeAiOauth?: { subscriptionEmail?: unknown; email?: unknown };
  account?: { email?: unknown };
  email?: unknown;
}

/**
 * A dir started in but never logged into holds the file without the profile
 * block, so the block is the signal. Claude rewrites this file about once a
 * minute, which makes a torn read ordinary rather than exceptional.
 */
function probeProfile(configDir: string): Probe {
  const filePath = path.join(configDir, '.claude.json');
  if (!fs.existsSync(filePath)) return 'absent';

  const data = readJson(filePath);
  if (data === undefined) return 'unreadable';
  if (typeof data !== 'object' || data === null) return 'absent';

  const profile = (data as ProfileFile).oauthAccount;
  if (!profile || typeof profile !== 'object') return 'absent';

  const email = normalizeEmail(profile.emailAddress) ?? normalizeEmail(profile.email);
  // An organization login can withhold the address; the uuid still proves one.
  if (!email && !profile.accountUuid) return 'absent';
  return { loggedIn: true, email };
}

/**
 * Presence is the evidence here — the token file only exists once OAuth wrote
 * it. The address inside is a bonus whose shape moves between Claude versions.
 */
function probeTokenFile(configDir: string): Probe {
  for (const name of CREDENTIAL_FILES) {
    const filePath = path.join(configDir, name);
    if (!fs.existsSync(filePath)) continue;

    const creds = readJson(filePath) as TokenFile | undefined;
    const email =
      normalizeEmail(creds?.claudeAiOauth?.subscriptionEmail) ??
      normalizeEmail(creds?.claudeAiOauth?.email) ??
      normalizeEmail(creds?.account?.email) ??
      normalizeEmail(creds?.email);
    return { loggedIn: true, email };
  }
  return 'absent';
}

/** What the account's config dir currently says about its login. */
export function resolveAccountIdentity(configDir: string): AccountIdentity {
  if (!configDir) return LOGGED_OUT;

  let unreadable = false;
  for (const probe of [probeProfile, probeTokenFile]) {
    const result = probe(configDir);
    if (result === 'unreadable') unreadable = true;
    else if (result !== 'absent') return result;
  }

  // An artifact we could not read is not an account that never logged in, and
  // withholding the claim is what keeps the label off a working account.
  return unreadable ? UNKNOWN : LOGGED_OUT;
}

/**
 * Overlay what the config dir says onto a stored row. The recorded email
 * stands in only where the dir could not be read; a readable dir showing no
 * login is the authority, or a logout could never surface.
 */
export function withAccountIdentity(account: ClaudeAccount): ClaudeAccount {
  const identity = resolveAccountIdentity(account.configDir);
  const storedEmail = normalizeEmail(account.email);

  let loggedIn = identity.loggedIn;
  if (loggedIn === undefined && storedEmail !== null) loggedIn = true;

  return { ...account, email: identity.email ?? storedEmail, loggedIn };
}
