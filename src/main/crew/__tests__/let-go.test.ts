import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LET_GO_KEEP_MS, letGoHire, moveHireAside, sweepLetGo, type LetGoDeps } from '../let-go';
import type { EditResultFrame } from '../protocol';

const HIRE = '11111111-1111-4111-8111-111111111111';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const userData = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'let-go-'));
  dirs.push(d);
  return d;
};

function deps(result: EditResultFrame['result'] | null, over: Partial<LetGoDeps> = {}) {
  const calls: string[] = [];
  const d: LetGoDeps = {
    online: () => true,
    sendDelete: (hireId) => (calls.push(`delete:${hireId}`), 'e1'),
    editResult: async (id) => (calls.push(`wait:${id}`), result === null ? null : { type: 'edit_result', id, result, why: 'not the owner' }),
    forget: (hireId) => void calls.push(`forget:${hireId}`),
    interrupt: (hireId) => void calls.push(`interrupt:${hireId}`),
    moveAside: (hireId) => void calls.push(`move:${hireId}`),
    onLateResult: (id) => void calls.push(`late:${id}`),
    ...over,
  };
  return { d, calls };
}

describe('letting a hire go', () => {
  test('the Hub applies the delete first; then the lease and jobs go before the run stops, so nothing reruns it, and the folder moves aside', async () => {
    const { d, calls } = deps('applied');
    expect(await letGoHire(d, HIRE)).toEqual({ ok: true });
    expect(calls).toEqual([`delete:${HIRE}`, 'wait:e1', `forget:${HIRE}`, `interrupt:${HIRE}`, `move:${HIRE}`]);
  });

  test('an answer that arrives after the wait still stops the hire and moves its folder aside; a late refusal does not', async () => {
    for (const result of ['applied', 'refused'] as const) {
      let late: ((f: EditResultFrame) => void) | null = null;
      const { d, calls } = deps(null, { onLateResult: (_id, handle) => void (late = handle) });
      expect((await letGoHire(d, HIRE)).ok).toBe(false);
      expect(calls).toEqual([`delete:${HIRE}`, 'wait:e1']);
      (late as unknown as (f: EditResultFrame) => void)({ type: 'edit_result', id: 'e1', result });
      expect(calls.slice(2)).toEqual(result === 'applied' ? [`forget:${HIRE}`, `interrupt:${HIRE}`, `move:${HIRE}`] : []);
    }
  });

  test('a refusal, no answer or no connection leaves the hire and its folder alone', async () => {
    for (const result of ['refused', 'conflict', null] as const) {
      const { d, calls } = deps(result);
      expect((await letGoHire(d, HIRE)).ok).toBe(false);
      expect(calls.filter((c) => c.startsWith('move') || c.startsWith('interrupt') || c.startsWith('forget'))).toEqual([]);
    }
    const offline = deps('applied', { online: () => false });
    expect(await letGoHire(offline.d, HIRE)).toEqual({ ok: false, error: "Crew Hub isn't connected, so the hire can't be let go now." });
    expect(offline.calls).toEqual([]);
  });

  test('the folder moves to crew/.let-go and is deleted after 30 days', () => {
    const root = userData();
    fs.mkdirSync(path.join(root, 'crew', HIRE, 'work'), { recursive: true });
    fs.writeFileSync(path.join(root, 'crew', HIRE, 'work', 'a.txt'), 'x');
    moveHireAside(root, HIRE, 1000);
    expect(fs.existsSync(path.join(root, 'crew', HIRE))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'crew', '.let-go', HIRE, 'work', 'a.txt'), 'utf8')).toBe('x');
    sweepLetGo(root, 1000 + LET_GO_KEEP_MS - 1);
    expect(fs.existsSync(path.join(root, 'crew', '.let-go', HIRE))).toBe(true);
    sweepLetGo(root, 1000 + LET_GO_KEEP_MS);
    expect(fs.existsSync(path.join(root, 'crew', '.let-go', HIRE))).toBe(false);
  });

  test('a let-go folder with no stamp ages from the folder itself', () => {
    const root = userData();
    fs.mkdirSync(path.join(root, 'crew', '.let-go', HIRE), { recursive: true });
    sweepLetGo(root, Date.now() + LET_GO_KEEP_MS + 60_000);
    expect(fs.existsSync(path.join(root, 'crew', '.let-go', HIRE))).toBe(false);
  });

  test('a hire with no folder on this machine moves nothing, and a missing .let-go sweeps nothing', () => {
    const root = userData();
    expect(() => moveHireAside(root, HIRE, 1)).not.toThrow();
    expect(() => sweepLetGo(root, 1)).not.toThrow();
  });
});
