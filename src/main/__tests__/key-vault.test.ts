/**
 * Provider API-key vault tests (#99). Electron's safeStorage is stubbed with
 * a reversible transform and preferences with an in-memory map, so the whole
 * store/opt-in/inject/test/delete lifecycle is exercised without an OS
 * keychain. The subscription-preservation invariant — a stored key changes
 * nothing until the per-provider toggle is enabled — is asserted explicitly.
 *
 * Run with: bun test src/main/__tests__
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';

let encryptionAvailable = true;
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const raw = b.toString('utf8');
      if (!raw.startsWith('enc:')) throw new Error('bad ciphertext');
      return raw.slice(4);
    },
  },
}));

const prefs = new Map<string, string>();
mock.module('../repositories/preferences', () => ({
  getPreference: (k: string) => prefs.get(k) ?? null,
  setPreference: (k: string, v: string) => {
    prefs.set(k, v);
  },
  deletePreference: (k: string) => {
    prefs.delete(k);
  },
}));

const vault = await import('../key-vault');

const realFetch = globalThis.fetch;

beforeEach(() => {
  prefs.clear();
  encryptionAvailable = true;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('key storage', () => {
  test('stores keys encrypted — plaintext never reaches preferences', () => {
    vault.setKey('claude', 'sk-ant-secret');
    expect(vault.hasKey('claude')).toBe(true);
    for (const value of prefs.values()) {
      expect(value.includes('sk-ant-secret')).toBe(false);
    }
  });

  test('rejects empty keys and unknown providers', () => {
    expect(() => vault.setKey('claude', '   ')).toThrow(/empty/);
    expect(() => vault.setKey('nope', 'sk-x')).toThrow(/Unknown session provider/);
  });

  test('throws when encryption is unavailable, and reports it in statuses', () => {
    encryptionAvailable = false;
    expect(() => vault.setKey('claude', 'sk-x')).toThrow(/not available/);
    expect(vault.listVaultStatuses().every(s => !s.available)).toBe(true);
  });

  test('deleteKey removes the key and the opt-in flag', () => {
    vault.setKey('grok', 'xai-key');
    vault.setUseKey('grok', true);
    vault.deleteKey('grok');
    expect(vault.hasKey('grok')).toBe(false);
    expect(vault.useKey('grok')).toBe(false);
  });
});

describe('subscription-preservation invariant', () => {
  test('a stored key injects NOTHING until the toggle is enabled', () => {
    vault.setKey('claude', 'sk-ant-secret');
    expect(vault.vaultEnvFor('claude')).toEqual({});
  });

  test('opt-in injects the provider env var; opt-out reverts', () => {
    vault.setKey('claude', 'sk-ant-secret');
    vault.setUseKey('claude', true);
    expect(vault.vaultEnvFor('claude')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-secret' });
    vault.setUseKey('claude', false);
    expect(vault.vaultEnvFor('claude')).toEqual({});
  });

  test('cannot enable the toggle without a stored key', () => {
    expect(() => vault.setUseKey('codex', true)).toThrow(/No API key/);
  });

  test('providers without keys always inject nothing', () => {
    expect(vault.vaultEnvFor('grok')).toEqual({});
  });
});

describe('testKey', () => {
  test('valid key hits the provider models endpoint with its auth header', async () => {
    vault.setKey('claude', 'sk-ant-valid');
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = (async (url: any, init: any) => {
      seenUrl = String(url);
      seenHeaders = init.headers;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const result = await vault.testKey('claude');
    expect(result.ok).toBe(true);
    expect(seenUrl).toBe('https://api.anthropic.com/v1/models');
    expect(seenHeaders['x-api-key']).toBe('sk-ant-valid');
    expect(seenHeaders['anthropic-version']).toBe('2023-06-01');
  });

  test('401 reports a rejected key', async () => {
    vault.setKey('codex', 'sk-bad');
    globalThis.fetch = (async () => new Response('', { status: 401 })) as typeof fetch;
    const result = await vault.testKey('codex');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Key rejected');
  });

  test('network failure reports unreachable', async () => {
    vault.setKey('grok', 'xai-x');
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const result = await vault.testKey('grok');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unreachable');
  });

  test('no stored key short-circuits without a network call', async () => {
    const result = await vault.testKey('codex');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No API key');
  });
});
