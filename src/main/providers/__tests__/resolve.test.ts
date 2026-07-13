/**
 * Provider resolution tests (#96).
 *
 * Run with: bun test src/main/providers
 */
import { describe, expect, test, mock } from 'bun:test';

// providers/claude.ts calls electron's app.getPath at buildCommand time only,
// but the module import chain still pulls in 'electron' — stub it.
mock.module('electron', () => ({
  app: { getPath: () => '/tmp/bodhilander-test-userdata' },
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
