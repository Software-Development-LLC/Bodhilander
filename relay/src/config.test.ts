/**
 * The handoff knobs an operator can turn. Both have a shipped default the
 * desktop assumes, so a deployment that overrides one and not the other is
 * worth being able to see.
 */
import { describe, expect, test } from 'bun:test';
import { ConfigError, loadConfig } from './config';

const BASE = { NODE_ENV: 'test', PUBLIC_URL: 'http://relay.test' };

describe('handoff storage limits', () => {
  test('default to a week, 256 MiB per bundle and 8 GiB across the store', () => {
    const { config } = loadConfig(BASE);
    expect(config.handoffTtlSeconds).toBe(7 * 24 * 60 * 60);
    expect(config.handoffMaxBytes).toBe(256 * 1024 * 1024);
    expect(config.handoffStoreMaxBytes).toBe(8 * 1024 * 1024 * 1024);
  });

  test('put bundles beside the database, which is what the volume holds', () => {
    const { config } = loadConfig({ ...BASE, DB_PATH: '/data/relay.db' });
    expect(config.handoffDir).toBe('/data/handoffs');
    expect(loadConfig({ ...BASE, HANDOFF_DIR: '/elsewhere' }).config.handoffDir).toBe('/elsewhere');
  });

  test('are overridable per deployment', () => {
    const { config } = loadConfig({ ...BASE, HANDOFF_TTL_SECONDS: '3600', HANDOFF_MAX_BYTES: '1048576' });
    expect(config.handoffTtlSeconds).toBe(3600);
    expect(config.handoffMaxBytes).toBe(1048576);
  });

  test('fail loudly rather than falling back to a default nobody chose', () => {
    expect(() => loadConfig({ ...BASE, HANDOFF_TTL_SECONDS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE, HANDOFF_MAX_BYTES: 'lots' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE, HANDOFF_STORE_MAX_BYTES: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE, HANDOFF_TTL_SECONDS: '-1' })).toThrow(ConfigError);
  });
});
