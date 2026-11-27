import { describe, expect, mock, test } from 'bun:test';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));

const { crewTools, bundlePath, BUILD_MESSAGE } = await import('../server');
import { HIRE, PERSON, crewDb, uuid } from '../../__tests__/crew-db';
import { markTainted } from '../../taint';

const BUNDLE = 'a'.repeat(64);

function setup(scope: 'owner' | 'circle' = 'owner') {
  const { raw, db } = crewDb();
  raw.query(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, text) VALUES (?, ?, 1, ?, ?, 'hi')`).run(uuid(1), HIRE, scope, PERSON);
  raw.query(`INSERT INTO crew_hire_cache (hire_id, rev, data) VALUES (?, 1, ?)`).run(HIRE, JSON.stringify({ skillBundleHash: BUNDLE }));
  raw.query(`INSERT INTO crew_note (note_id, hire_id, scope, path, body) VALUES ('n1', ?, 'owner', 'plan.md', 'owner text'), ('n2', ?, 'shared', 'team.md', 'shared text')`).run(HIRE, HIRE);
  const cards: [string, Record<string, unknown>][] = [];
  let ids = 0;
  const tools = crewTools({ db, raiseCard: (jobId, raise) => (cards.push([jobId, raise as unknown as Record<string, unknown>]), true), newId: () => uuid(50 + ++ids) }, { id: uuid(1), hireId: HIRE, scope }, `chat:${scope}`);
  const text = async (name: string, args: Record<string, unknown>) => (await tools.call(name, args)).content[0].text;
  return { raw, db, tools, cards, text };
}

describe('Crew tools', () => {
  test('send raises an outbound card for the recipient, tainted as the thread is', async () => {
    const t = setup();
    markTainted(t.db, HIRE, 'chat:owner', 'web_fetch');
    await t.tools.call('send', { recipient: 'ana@bodhi.example', text: 'hello' });
    expect(t.cards).toEqual([[uuid(1), { id: uuid(51), kind: 'outbound', tainted: true, payload: { recipient: 'ana@bodhi.example', text: 'hello' }, inboundId: uuid(1) }]]);
    expect((await t.tools.call('send', { recipient: 'nobody', text: 'x' })).isError).toBe(true);
    expect((await t.tools.call('send', { recipient: 'a@b.c', text: 'x'.repeat(28_001) })).isError).toBe(true);
  });

  test('note_read reads by the job\'s run scope: a circle run never sees owner notes', async () => {
    expect(await setup('owner').text('note_read', { scope: 'owner', path: 'plan.md' })).toBe('owner text');
    const circle = setup('circle');
    expect(await circle.text('note_read', { scope: 'shared', path: 'team.md' })).toBe('shared text');
    const refused = await circle.tools.call('note_read', { scope: 'owner', path: 'plan.md' });
    expect(refused.isError).toBe(true);
    expect((circle.raw.query(`SELECT COUNT(*) AS n FROM crew_audit WHERE event = 'note-scope-refused'`).get() as { n: number }).n).toBe(1);
  });

  test('skill_propose raises a skill_change card against the pinned bundle and writes nothing', async () => {
    const t = setup();
    await t.tools.call('skill_propose', { files: [{ path: 'triage/SKILL.md', content: '# new' }] });
    expect(t.cards[0][1]).toMatchObject({ kind: 'skill_change', tainted: false, payload: { baseBundle: BUNDLE, files: [{ path: 'triage/SKILL.md', content: '# new' }] } });
  });

  test('skill_propose refuses paths outside the bundle and proposals over 1 MB', async () => {
    const t = setup();
    for (const p of ['../x', '/etc/passwd', 'a/../../b', 'a\\b', 'a//b', './a', '']) {
      expect((await t.tools.call('skill_propose', { files: [{ path: p, content: 'x' }] })).isError).toBe(true);
    }
    const big = 'x'.repeat(600 * 1024);
    expect((await t.tools.call('skill_propose', { files: [{ path: 'a.md', content: big }, { path: 'b.md', content: big }] })).isError).toBe(true);
    expect(t.cards).toEqual([]);
    expect(bundlePath('skills/a.md')).toBe('skills/a.md');
  });

  test('start_build is refused until phase 2', async () => {
    const t = setup();
    const r = await t.tools.call('start_build', { issue: '1' });
    expect(r).toEqual({ content: [{ type: 'text', text: BUILD_MESSAGE }], isError: true });
  });
});
