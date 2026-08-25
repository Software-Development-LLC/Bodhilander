/**
 * Login evidence for one account's isolated CLAUDE_CONFIG_DIR. A token file
 * exists only where the OS has no secret store; .claude.json is written
 * everywhere, and gains an `oauthAccount` block at login.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ClaudeAccount } from '../shared/types';

export interface AccountIdentity {
  /** True when the config dir carries evidence that a login completed. */
  loggedIn: boolean;
  /** The logged-in profile's address, when the artifact records one. */
  email: string | null;
}

const LOGGED_OUT: AccountIdentity = { loggedIn: false, email: null };

/** The plaintext token stores, present only on platforms without a keyring. */
const CREDENTIAL_FILES = ['.credentials.json', 'auth.json'];

/** Every filename whose arrival or rewrite can mean a login just finished. */
export const LOGIN_ARTIFACTS: ReadonlySet<string> = new Set([
  ...CREDENTIAL_FILES,
  '.claude.json',
]);

function readJsonFile(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
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

/**
 * A config dir that has been started but never logged into has the file
 * without the profile block, so the block — not the file — is the signal.
 */
function identityFromProfile(configDir: string): AccountIdentity | null {
  const data = readJsonFile(path.join(configDir, '.claude.json'));
  const profile = data?.oauthAccount;
  if (!profile || typeof profile !== 'object') return null;

  const email = normalizeEmail(profile.emailAddress) ?? normalizeEmail(profile.email);
  // An organization login can withhold the address; the uuid still proves one.
  if (!email && !profile.accountUuid) return null;
  return { loggedIn: true, email };
}

/**
 * Presence is the evidence here — the token file only exists once OAuth wrote
 * it. The address inside is a bonus whose shape moves between Claude versions.
 */
function identityFromTokenFile(configDir: string): AccountIdentity | null {
  for (const name of CREDENTIAL_FILES) {
    const filePath = path.join(configDir, name);
    if (!fs.existsSync(filePath)) continue;

    const creds = readJsonFile(filePath);
    const email =
      normalizeEmail(creds?.claudeAiOauth?.subscriptionEmail) ??
      normalizeEmail(creds?.claudeAiOauth?.email) ??
      normalizeEmail(creds?.account?.email) ??
      normalizeEmail(creds?.email);
    return { loggedIn: true, email };
  }
  return null;
}

/** What the account's config dir currently says about its login. */
export function resolveAccountIdentity(configDir: string): AccountIdentity {
  if (!configDir) return LOGGED_OUT;
  return identityFromProfile(configDir) ?? identityFromTokenFile(configDir) ?? LOGGED_OUT;
}

/**
 * Overlay the on-disk truth onto a stored account row. The stored email is
 * kept as a fallback: it was only ever written when a login completed, so it
 * still corroborates one if Claude Code moves the artifacts probed above.
 */
export function withAccountIdentity(account: ClaudeAccount): ClaudeAccount {
  const identity = resolveAccountIdentity(account.configDir);
  const storedEmail = normalizeEmail(account.email);
  return {
    ...account,
    email: identity.email ?? storedEmail,
    loggedIn: identity.loggedIn || storedEmail !== null,
  };
}
