/**
 * Provider resolution tests (#96).
 *
 * Run with: bun test src/main/providers
 */
import { describe, expect, test, mock } from 'bun:test';

// providers/claude.ts calls electron's app.getPath at buildCommand time only,
// but the module import chain still pulls in 'electron' — stub it. The path
// is never dereferenced by these tests (buildCommand is not exercised here).
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
}));

const providers = await import('../index');

describe('provider registry resolution', () => {
  test('isKnownProvider reflects the registry', () => {
    expect(providers.isKnownProvider('claude')).toBe(true);
    expect(providers.isKnownProvider('codex')).toBe(true);
    expect(providers.isKnownProvider('gemini')).toBe(true);
    expect(providers.isKnownProvider('grok')).toBe(true);
    expect(providers.isKnownProvider('nope')).toBe(false);
    expect(providers.isKnownProvider('')).toBe(false);
  });

  test('resolveProvider returns the matching definition for known ids', () => {
    for (const id of ['claude', 'codex', 'gemini', 'grok']) {
      expect(providers.resolveProvider(id).id).toBe(id);
    }
  });

  test('resolveProvider degrades unknown ids to the default provider', () => {
    expect(providers.resolveProvider('from-a-newer-version').id).toBe(providers.DEFAULT_PROVIDER_ID);
  });

  test('resolveProvider treats null/undefined/empty as the default', () => {
    expect(providers.resolveProvider(undefined).id).toBe(providers.DEFAULT_PROVIDER_ID);
    expect(providers.resolveProvider(null).id).toBe(providers.DEFAULT_PROVIDER_ID);
    expect(providers.resolveProvider('').id).toBe(providers.DEFAULT_PROVIDER_ID);
  });

  test('getProvider still throws for unknown ids (programming errors)', () => {
    expect(() => providers.getProvider('nope')).toThrow(/Unknown session provider/);
  });
});

describe('resolveLaunchProviderId precedence (#98)', () => {
  test('the persisted row wins once it exists (#96 invariant)', () => {
    expect(providers.resolveLaunchProviderId('grok', 'codex')).toBe('grok');
  });

  test('the explicit id bridges the not-yet-persisted-row gap', () => {
    expect(providers.resolveLaunchProviderId(undefined, 'codex')).toBe('codex');
    expect(providers.resolveLaunchProviderId(null, 'gemini')).toBe('gemini');
  });

  test('falls back to the default when neither is available', () => {
    expect(providers.resolveLaunchProviderId(undefined, undefined)).toBe(providers.DEFAULT_PROVIDER_ID);
  });

  test('main and renderer defaults agree', async () => {
    const shared = await import('../../../shared/types');
    expect(providers.DEFAULT_PROVIDER_ID).toBe(shared.DEFAULT_SESSION_PROVIDER);
  });
});
