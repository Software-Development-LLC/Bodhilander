/**
 * Planning a cross-repo run (CO-722).
 *
 * The pure half of prepare: it must collect every fixable machine-config gap at
 * once, refuse a bad issue name or an empty pick, and otherwise produce the exact
 * `multi` run row the loop will bootstrap -- entering at `scoping`, with the
 * picks recorded and the tracking key derived the same way the harness does.
 *
 * Run with: bun test src/main/run-engine/__tests__/cross-repo-prepare.test.ts
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import { planCrossRepoRun, trackingId, type CrossRepoConfig } from '../cross-repo-prepare';

const OK: CrossRepoConfig = {
  pythonPath: 'python',
  harnessPath: 'C:/h',
  bodhiRoot: 'C:/root',
  initiativesRoot: 'C:/root/initiatives',
};

const id = () => 'run-fixed-id';

describe('trackingId mirrors the harness', () => {
  test('strips a descriptive suffix and uppercases the key', () => {
    expect(trackingId('bwa-4764-cross-repo-thing')).toBe('BWA-4764');
    expect(trackingId('BDH-12')).toBe('BDH-12');
  });
  test('passes an id through when it is not a KEY-N', () => {
    expect(trackingId('nightly-smoke')).toBe('nightly-smoke');
  });
});

describe('planCrossRepoRun refuses with a fixable list', () => {
  test('collects every missing machine setting at once', () => {
    const plan = planCrossRepoRun(
      { issueId: 'BDH-1', repos: ['a', 'b'] },
      { pythonPath: 'python', harnessPath: null, bodhiRoot: null, initiativesRoot: null },
      id,
    );
    expect(plan.status).toBe('refused');
    if (plan.status !== 'refused') throw new Error('unreachable');
    const whats = plan.refusals.map((r) => r.what).join(' | ');
    expect(whats).toContain('harness');
    expect(whats).toContain('workspace root');
    expect(whats).toContain('initiatives folder');
  });

  test('refuses an issue id that is not a usable directory name', () => {
    const plan = planCrossRepoRun({ issueId: 'has space', repos: ['a', 'b'] }, OK, id);
    expect(plan.status).toBe('refused');
    if (plan.status !== 'refused') throw new Error('unreachable');
    expect(plan.refusals.some((r) => r.what.includes('initiative name'))).toBe(true);
  });

  test('refuses when no repo was picked', () => {
    const plan = planCrossRepoRun({ issueId: 'BDH-1', repos: [] }, OK, id);
    expect(plan.status).toBe('refused');
    if (plan.status !== 'refused') throw new Error('unreachable');
    expect(plan.refusals.some((r) => r.what.includes('no repos'))).toBe(true);
  });

  test('empty and whitespace-only picks count as no pick', () => {
    const plan = planCrossRepoRun({ issueId: 'BDH-1', repos: ['', '   '] }, OK, id);
    expect(plan.status).toBe('refused');
  });
});

describe('planCrossRepoRun produces the run row', () => {
  test('a multi run entering at scoping, with the picks and derived key', () => {
    const plan = planCrossRepoRun(
      { issueId: 'BWA-4764-thing', repos: ['bodhi-service-api', 'bodhi-web-apps'], budgetUsd: 20 },
      OK,
      id,
    );
    expect(plan.status).toBe('create');
    if (plan.status !== 'create') throw new Error('unreachable');
    expect(plan.input).toEqual({
      id: 'run-fixed-id',
      initiativeKey: 'BWA-4764',
      initiativeDir: path.join('C:/root/initiatives', 'BWA-4764-thing'),
      harnessPath: 'C:/h',
      bodhiRoot: 'C:/root',
      pythonPath: 'python',
      permissionPosture: 'manual',
      budgetUsd: 20,
      kind: 'multi',
      bootstrapState: 'scoping',
      scopeRepos: ['bodhi-service-api', 'bodhi-web-apps'],
    });
  });

  test('a repo picked twice becomes one owner', () => {
    const plan = planCrossRepoRun({ issueId: 'BDH-1', repos: ['a', 'a', 'b'] }, OK, id);
    if (plan.status !== 'create') throw new Error('expected create');
    expect(plan.input.scopeRepos).toEqual(['a', 'b']);
  });

  test('no budget records null, not undefined', () => {
    const plan = planCrossRepoRun({ issueId: 'BDH-1', repos: ['a', 'b'] }, OK, id);
    if (plan.status !== 'create') throw new Error('expected create');
    expect(plan.input.budgetUsd).toBeNull();
  });
});
