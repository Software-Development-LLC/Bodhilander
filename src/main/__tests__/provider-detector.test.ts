/**
 * Provider CLI detection tests (#97).
 *
 * Asserts the machine-independent contract (one status per registered
 * provider, fully populated fields); whether a given CLI is actually
 * installed depends on the machine, so `installed` is only type-checked.
 *
 * Run with: bun test src/main/__tests__
 */
import { describe, expect, test, mock } from 'bun:test';

mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
}));
// preferences pulls in better-sqlite3 via the database module — stub it.
mock.module('../repositories/preferences', () => ({
  getPreference: () => '',
}));

const { detectProviders } = await import('../provider-detector');
const { listProviders } = await import('../providers');

describe('detectProviders', () => {
  test('returns a fully-populated status for every registered provider', async () => {
    const statuses = await detectProviders();
    const registry = listProviders();

    expect(statuses.map((s) => s.id).sort()).toEqual(registry.map((p) => p.id).sort());

    for (const s of statuses) {
      expect(typeof s.installed).toBe('boolean');
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.command.length).toBeGreaterThan(0);
      expect(s.installHint.length).toBeGreaterThan(0);
      expect(s.docsUrl.startsWith('https://')).toBe(true);
      expect(s.loginHint.length).toBeGreaterThan(0);
      if (!s.installed) {
        expect(s.version).toBeNull();
      }
    }
  }, 30_000);
});
