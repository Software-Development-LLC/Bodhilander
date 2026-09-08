/**
 * The handoff knobs an operator can turn. Both have a shipped default the
 * desktop assumes, so a deployment that overrides one and not the other is
 * worth being able to see.
 */
import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
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
    // "Beside the database" as two independent facts. The old assertion was a
    // POSIX literal, and `path.resolve('/data/relay.db')` is `C:\data\relay.db`
    // on Windows — so it failed there for a reason the relay, which only ever
    // runs in a Linux container, does not actually have.
    const dbPath = path.join(os.tmpdir(), 'relay-config-test', 'relay.db');
    const { config } = loadConfig({ ...BASE, DB_PATH: dbPath });
    expect(path.dirname(config.handoffDir)).toBe(path.dirname(dbPath));
    expect(path.basename(config.handoffDir)).toBe('handoffs');
    expect(loadConfig({ ...BASE, HANDOFF_DIR: '/elsewhere' }).config.handoffDir).toBe('/elsewhere');
  });

  test('refuse an in-memory database with nowhere named to put the bundles', () => {
    // There is no directory to sit beside, and the obvious stand-in — a fixed
    // name under the system temp directory — is a world-writable path holding
    // other people's sealed bundles. Say so instead of picking it.
    expect(() => loadConfig({ ...BASE, DB_PATH: ':memory:' })).toThrow(ConfigError);
    expect(loadConfig({ ...BASE, DB_PATH: ':memory:', HANDOFF_DIR: '/elsewhere' }).config.handoffDir).toBe('/elsewhere');
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
