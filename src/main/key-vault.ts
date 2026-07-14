/**
 * Provider API-key vault (#99).
 *
 * Keys are encrypted with Electron's safeStorage (OS keychain: Keychain on
 * macOS, DPAPI on Windows, libsecret on Linux) and persisted as base64 blobs
 * in the existing preferences table. Plaintext keys never touch the DB, logs,
 * or the renderer — the IPC surface only reports whether a key is stored.
 *
 * A stored key does nothing by itself: it is injected into a provider's
 * launch environment only when the user flips the per-provider "use API key"
 * toggle. CLI login/subscription remains the default (issue #100 decision).
 */
import { safeStorage } from 'electron';
import log from 'electron-log';
import { getPreference, setPreference, deletePreference } from './repositories/preferences';
import { getProvider, listProviders, ProviderDefinition } from './providers';
import { KeyVaultStatus } from '../shared/types';

const KEY_PREF_PREFIX = 'providerApiKey.';
const USE_PREF_PREFIX = 'providerApiKeyUse.';
const TEST_TIMEOUT_MS = 10_000;

type ApiKeyConfig = NonNullable<ProviderDefinition['apiKey']>;

/** Resolve a provider that supports API keys; throws for unknown ids or key-less providers. */
function requireApiKeyConfig(providerId: string): ApiKeyConfig {
  const config = getProvider(providerId).apiKey;
  if (!config) {
    throw new Error(`Provider '${providerId}' does not support API keys`);
  }
  return config;
}

export function isVaultAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export function hasKey(providerId: string): boolean {
  return getPreference(KEY_PREF_PREFIX + providerId) !== null;
}

export function useKey(providerId: string): boolean {
  return getPreference(USE_PREF_PREFIX + providerId) === 'true';
}

export function setKey(providerId: string, key: string): void {
  requireApiKeyConfig(providerId);
  if (!isVaultAvailable()) {
    throw new Error('Secure key storage is not available on this system');
  }
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error('API key is empty');
  }
  const encrypted = safeStorage.encryptString(trimmed).toString('base64');
  setPreference(KEY_PREF_PREFIX + providerId, encrypted);
}

export function deleteKey(providerId: string): void {
  getProvider(providerId); // throws on unknown ids
  deletePreference(KEY_PREF_PREFIX + providerId);
  deletePreference(USE_PREF_PREFIX + providerId);
}

export function setUseKey(providerId: string, use: boolean): void {
  requireApiKeyConfig(providerId);
  if (use && !hasKey(providerId)) {
    throw new Error('No API key stored for this provider');
  }
  setPreference(USE_PREF_PREFIX + providerId, use ? 'true' : 'false');
}

/** Decrypt a stored key. Main-process only — never exposed over IPC. */
function decryptKey(providerId: string): string | null {
  const blob = getPreference(KEY_PREF_PREFIX + providerId);
  if (blob === null || !isVaultAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch {
    // Wrong OS-keychain state (e.g. restored DB on another machine). Detail
    // deliberately not logged — nothing key-adjacent goes to logs.
    log.error(`[KeyVault] Failed to decrypt key for '${providerId}'`);
    return null;
  }
}

/**
 * Env vars to merge into a provider launch: the provider's API-key env var
 * when — and only when — a key is stored AND the user opted in for this
 * provider. Empty otherwise, leaving CLI login/subscription auth untouched.
 */
export function vaultEnvFor(providerId: string): Record<string, string> {
  if (!useKey(providerId)) return {};
  const key = decryptKey(providerId);
  if (key === null) return {};
  try {
    return { [requireApiKeyConfig(providerId).envVar]: key };
  } catch {
    // Unknown provider or one without API-key support — inject nothing.
    return {};
  }
}

export interface KeyTestResult {
  ok: boolean;
  /** HTTP status from the provider's validation endpoint, when reached. */
  status: number | null;
  error: string | null;
}

/** Validate the stored key against the provider's cheap models endpoint. */
export async function testKey(providerId: string): Promise<KeyTestResult> {
  const config = requireApiKeyConfig(providerId);
  const key = decryptKey(providerId);
  if (key === null) {
    return { ok: false, status: null, error: 'No API key stored' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const res = await fetch(config.test.url, {
      headers: config.test.headers(key),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, status: res.status, error: null };
    const reason = res.status === 401 || res.status === 403 ? 'Key rejected' : 'Unexpected response';
    return { ok: false, status: res.status, error: `${reason} (HTTP ${res.status})` };
  } catch (e: any) {
    const message = e?.name === 'AbortError' ? 'Timed out' : 'Endpoint unreachable';
    return { ok: false, status: null, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

export function listVaultStatuses(): KeyVaultStatus[] {
  const available = isVaultAvailable();
  // Providers without apiKey support are not applicable and don't appear.
  return listProviders()
    .filter((p) => p.apiKey !== undefined)
    .map((p) => ({
      providerId: p.id,
      available,
      hasKey: hasKey(p.id),
      useKey: useKey(p.id),
    }));
}
