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
  const ALL_IDS = ['claude', 'codex', 'grok', 'opencode', 'kimi', 'cursor', 'antigravity'];

  test('isKnownProvider reflects the registry', () => {
    for (const id of ALL_IDS) {
      expect(providers.isKnownProvider(id)).toBe(true);
    }
    expect(providers.isKnownProvider('nope')).toBe(false);
    expect(providers.isKnownProvider('')).toBe(false);
  });

  test('resolveProvider returns the matching definition for known ids', () => {
    for (const id of ALL_IDS) {
      expect(providers.resolveProvider(id).id).toBe(id);
    }
  });

  test('every registered provider exposes an arena command + parser', () => {
    for (const p of providers.listProviders()) {
      expect(typeof p.arena.buildCommand).toBe('function');
      expect(typeof p.arena.createParser).toBe('function');
    }
  });

  test('follow-up resume is supported by every provider except antigravity', () => {
    // antigravity has no machine-readable conversation id to resume, so it
    // deliberately omits buildResumeCommand (the engine skips it in follow-up
    // rounds). Every other provider supports resumable arena conversations.
    for (const p of providers.listProviders()) {
      const hasResume = typeof p.arena.buildResumeCommand === 'function';
      expect(hasResume).toBe(p.id !== 'antigravity');
    }
  });

  test('resolveProvider degrades unknown ids to the default provider', () => {
    expect(providers.resolveProvider('from-a-newer-version').id).toBe(providers.DEFAULT_PROVIDER_ID);
    // 'gemini' was a registered provider until Google retired its consumer
    // OAuth login; persisted gemini sessions must degrade the same way.
    expect(providers.resolveProvider('gemini').id).toBe(providers.DEFAULT_PROVIDER_ID);
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
    expect(providers.resolveLaunchProviderId(null, 'grok')).toBe('grok');
  });

  test('falls back to the default when neither is available', () => {
    expect(providers.resolveLaunchProviderId(undefined, undefined)).toBe(providers.DEFAULT_PROVIDER_ID);
  });

  test('main and renderer defaults agree', async () => {
    const shared = await import('../../../shared/types');
    expect(providers.DEFAULT_PROVIDER_ID).toBe(shared.DEFAULT_SESSION_PROVIDER);
  });
});
