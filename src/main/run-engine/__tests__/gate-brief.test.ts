import { describe, expect, test } from 'bun:test';
import { gateBrief, type RunFacts } from '../gate-brief';

const FACTS: RunFacts = {
  initiativeKey: 'BDH-239',
  initiativePath: 'C:\\scratch\\initiatives\\BDH-239-handoff-delete-rate-limit',
  repo: 'Bodhilander',
  worktree: 'C:\\work\\repos\\_wt-bdh-239-Bodhilander',
  harnessPath: 'C:\\work\\repos\\claude-team-workflow',
  gate: 2,
};

describe('what a gate is told about its run', () => {
  test('the whole brief, pinned', () => {
    // Deliberately the entire output rather than a handful of `toContain`s.
    // The risk this module carries is not omitting a fact, which a gate
    // notices immediately -- it is quietly GROWING an instruction, which
    // makes the sequencer a second copy of the process that disagrees with
    // the harness and wins because it is closer. Anything added fails here.
    expect(gateBrief(FACTS, 'Fix the rate-limit bucket.')).toBe(
      [
        '# This run',
        '',
        'initiative   BDH-239',
        'repo         Bodhilander',
        'gate         2',
        'worktree     C:\\work\\repos\\_wt-bdh-239-Bodhilander',
        'directory    C:\\scratch\\initiatives\\BDH-239-handoff-delete-rate-limit',
        'harness      C:\\work\\repos\\claude-team-workflow',
        '',
        'team.yaml and seams.yaml are in the initiative directory above.',
        'Harness scripts are under the harness path above, by absolute path.',
        '',
        '# Task',
        '',
        'Fix the rate-limit bucket.',
      ].join('\n'),
    );
  });

  test('the task is carried through unchanged', () => {
    // The engine does not get to reword what a gate was asked to do. A
    // multi-line task keeps its shape, because its shape may be the point.
    const task = 'Read A.\nThen read B.\n\nReport in two sentences.';
    expect(gateBrief(FACTS, `\n\n${task}\n\n`)).toContain(`# Task\n\n${task}`);
  });

  test('every fact reaches the gate', () => {
    const brief = gateBrief(FACTS, 'go');
    for (const value of [
      FACTS.initiativeKey,
      FACTS.initiativePath,
      FACTS.repo,
      FACTS.worktree,
      FACTS.harnessPath,
    ]) {
      expect(brief).toContain(value);
    }
  });

  test('a different gate of the same run says so', () => {
    // The role comes from the harness, but WHICH gate is the run's to say.
    expect(gateBrief({ ...FACTS, gate: 4 }, 'go')).toContain('gate         4');
  });
});
