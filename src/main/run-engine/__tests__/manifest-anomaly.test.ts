/**
 * Seam-manifest anomaly checks (CO-722 B2).
 *
 * These gate auto-approval: a clean manifest drives on hands-off, an anomalous
 * one holds for a person. So the tests are about the line between the two --
 * what is sound enough to release, and what is worth a human's glance -- against
 * the real seams.yaml shape (top-level `merge_order`, a `seams:` list whose
 * entries carry `id` and `producer.repo`, optional `post_merge`).
 *
 * Run with: bun test src/main/run-engine/__tests__/manifest-anomaly.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { checkManifestAnomalies, manifestVerdict, MAX_SEAMS } from '../manifest-anomaly';

const SCOPE = ['bodhi-service-api', 'bodhi-web-apps'];

/** A minimal, sound manifest over SCOPE: two seams, both producers in scope. */
const CLEAN = `
initiative: CO-1
merge_order:
  - bodhi-service-api
  - bodhi-web-apps
seams:
  - id: task-dto
    producer:
      repo: bodhi-service-api
  - id: task-view
    producer:
      repo: bodhi-web-apps
`;

describe('a sound manifest is auto-approvable', () => {
  test('producers and merge order all in scope -> ok', () => {
    expect(checkManifestAnomalies(CLEAN, SCOPE)).toEqual({ ok: true });
  });

  test('a CONSUMER repo out of scope is fine -- consumers are references, not builds', () => {
    const withConsumer = `${CLEAN}    consumers:
      - repo: bodhi-mobile-app-bodhi-app
`;
    expect(checkManifestAnomalies(withConsumer, SCOPE)).toEqual({ ok: true });
  });
});

describe('an anomaly holds for a person', () => {
  test('no seams at all', () => {
    const result = checkManifestAnomalies('initiative: CO-1\nmerge_order: []\nseams: []\n', SCOPE);
    expect(result).toEqual({ ok: false, reason: 'the seam manifest declares no seams' });
  });

  test('a producer repo outside the run scope (it has no worktree)', () => {
    const bad = `
seams:
  - id: s1
    producer:
      repo: bodhi-service-ml
`;
    const result = checkManifestAnomalies(bad, SCOPE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('bodhi-service-ml');
  });

  test('a merge_order repo outside the run scope', () => {
    const bad = `
merge_order:
  - bodhi-service-api
  - bodhi-service-stack
seams:
  - id: s1
    producer:
      repo: bodhi-service-api
`;
    const result = checkManifestAnomalies(bad, SCOPE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('bodhi-service-stack');
  });

  test('a post_merge script targeting an out-of-scope repo', () => {
    const bad = `
seams:
  - id: s1
    producer:
      repo: bodhi-service-api
post_merge:
  - script: backfill
    repo: bodhi-service-insights
`;
    const result = checkManifestAnomalies(bad, SCOPE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('bodhi-service-insights');
  });

  test('two seams sharing an id', () => {
    const bad = `
seams:
  - id: dupe
    producer:
      repo: bodhi-service-api
  - id: dupe
    producer:
      repo: bodhi-web-apps
`;
    expect(checkManifestAnomalies(bad, SCOPE)).toEqual({ ok: false, reason: 'two seams share the id "dupe"' });
  });

  test('a runaway seam count', () => {
    const many = Array.from({ length: MAX_SEAMS + 1 }, (_, i) => `  - id: s${i}\n    producer:\n      repo: bodhi-service-api`).join('\n');
    const result = checkManifestAnomalies(`seams:\n${many}\n`, SCOPE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('runaway');
  });

  test('invalid YAML is a hold, not a throw', () => {
    const result = checkManifestAnomalies('seams: [unclosed\n  - : :\n', SCOPE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not valid YAML');
  });

  test('exactly at the ceiling is still ok (boundary)', () => {
    const many = Array.from({ length: MAX_SEAMS }, (_, i) => `  - id: s${i}\n    producer:\n      repo: bodhi-service-api`).join('\n');
    expect(checkManifestAnomalies(`seams:\n${many}\n`, SCOPE)).toEqual({ ok: true });
  });
});

describe('manifestVerdict handles a manifest that is not on disk', () => {
  test('a null (missing) manifest is a hold, not a spawn', () => {
    // arch reports parked only after writing seams.yaml, so null means it went
    // missing between the write and the read -- a person should look.
    expect(manifestVerdict(null, SCOPE)).toEqual({
      ok: false,
      reason: 'the seam manifest could not be read for review',
    });
  });

  test('a present manifest delegates to the anomaly check', () => {
    expect(manifestVerdict(CLEAN, SCOPE)).toEqual({ ok: true });
  });
});
