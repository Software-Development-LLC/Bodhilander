import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copyOfficeWork, findOfficeData, importFromOffice, officeEmployees, readOfficeEmployee, type ImportPort } from '../import-office';
import { HIRE } from './crew-db';

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function office() {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-office-'));
  made.push(appData);
  const data = path.join(appData, '@bodhi-office', 'desktop');
  const po = path.join(data, 'employees', 'fresh-po');
  const write = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(po, rel)), { recursive: true });
    fs.writeFileSync(path.join(po, rel), content);
  };
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'office.db'), '');
  write('skills/backlog-triage/SKILL.md', '# Triage');
  write('skills/.hidden', 'no');
  write('skills/big/SKILL.md', 'x'.repeat(1_048_577));
  write('notes/plan.md', 'the plan');
  write('work/triage.md', 'today');
  write('work/deep/board.json', '{}');
  fs.mkdirSync(path.join(data, 'employees', 'core-po', 'knowledge'), { recursive: true });
  const secret = path.join(appData, 'secret.txt');
  fs.writeFileSync(secret, 'outside');
  fs.symlinkSync(secret, path.join(po, 'work', 'link.txt'));
  fs.symlinkSync(secret, path.join(po, 'skills', 'link.md'));
  const owner = path.join(appData, 'crew', HIRE, 'owner');
  return { appData, data, po, owner };
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    out[name] = st.isSymbolicLink() ? `-> ${fs.readlinkSync(full)}` : st.isFile() ? fs.readFileSync(full, 'utf8').slice(0, 40) + `:${st.mtimeMs}` : 'dir';
  }
  return out;
}

describe('import from Office', () => {
  test('finds the Office data folder only when its database and employees are there', () => {
    const o = office();
    expect(findOfficeData(o.appData)).toBe(o.data);
    expect(officeEmployees(o.data)).toEqual(['fresh-po']);
    fs.rmSync(path.join(o.data, 'office.db'));
    expect(findOfficeData(o.appData)).toBeNull();
  });

  test('reads skills and notes, never a dotfile, a symlink or a file over the limit', () => {
    const o = office();
    const read = readOfficeEmployee(o.data, 'fresh-po');
    expect(read.skills).toEqual([{ path: 'backlog-triage/SKILL.md', content: '# Triage' }]);
    expect(read.notes).toEqual([{ path: 'plan.md', content: 'the plan' }]);
    expect(read.skipped).toEqual(['skills/big/SKILL.md']);
  });

  const BUNDLE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const port = (over: Partial<ImportPort> = {}, calls: unknown[][] = []): ImportPort => ({
    createBundle: async (...a) => (calls.push(['create', ...a]), { ok: true, objectId: BUNDLE }),
    bundleHash: async (...a) => (calls.push(['hash', ...a]), 'hub-hash'),
    pinBundle: async (...a) => (calls.push(['pin', ...a]), { ok: true }),
    writeOwnerNote: (...a) => (calls.push(['note', ...a]), true),
    ...over,
  });

  test('creates the bundle, pins it with the hash the Hub reports, sends owner notes, copies work, and leaves Office untouched', async () => {
    const o = office();
    const before = tree(o.data);
    const calls: unknown[][] = [];
    const summary = await importFromOffice(port({}, calls), { dataDir: o.data, handle: 'fresh-po', hireId: HIRE, role: 'product-owner', ownerDir: o.owner });
    expect(summary).toEqual({ skills: 1, notes: 1, work: 2, skipped: ['skills/big/SKILL.md'], failed: [] });
    expect(calls).toEqual([
      ['create', HIRE, 'product-owner', [{ path: 'backlog-triage/SKILL.md', content: '# Triage' }]],
      ['hash', BUNDLE],
      ['pin', HIRE, BUNDLE, 'hub-hash'],
      ['note', HIRE, 'owner/plan.md', 'the plan'],
    ]);
    expect(fs.readFileSync(path.join(o.owner, 'work', 'deep', 'board.json'), 'utf8')).toBe('{}');
    expect(fs.existsSync(path.join(o.owner, 'work', 'link.txt'))).toBe(false);
    expect(tree(o.data)).toEqual(before);
  });

  test('a refused or conflicting create or pin, or a bundle that never arrives, is listed under failed', async () => {
    const o = office();
    const input = { dataDir: o.data, handle: 'fresh-po', hireId: HIRE, role: 'product-owner', ownerDir: o.owner };
    const calls: unknown[][] = [];
    const refused = await importFromOffice(port({ createBundle: async () => ({ ok: false, why: 'refused: too big' }) }, calls), input);
    expect(refused).toMatchObject({ skills: 0, failed: ['skills (refused: too big)'] });
    expect(calls.some((c) => c[0] === 'pin' || c[0] === 'hash')).toBe(false);
    const conflict = await importFromOffice(port({ pinBundle: async () => ({ ok: false, why: 'conflict' }) }), input);
    expect(conflict.failed).toContain('skill pin (conflict)');
    expect(conflict.skills).toBe(1);
    const missing = await importFromOffice(port({ bundleHash: async () => null }), input);
    expect(missing.failed).toContain("skill pin (the bundle didn't arrive)");
  });

  test('a second copy lands beside the hire\'s work, and a third is refused', () => {
    const o = office();
    expect(copyOfficeWork(o.data, 'fresh-po', o.owner)).toBe(2);
    fs.writeFileSync(path.join(o.owner, 'work', 'triage.md'), 'edited by the hire');
    expect(copyOfficeWork(o.data, 'fresh-po', o.owner)).toBe(2);
    expect(fs.readFileSync(path.join(o.owner, 'work', 'triage.md'), 'utf8')).toBe('edited by the hire');
    expect(fs.readFileSync(path.join(o.owner, 'work-from-office', 'triage.md'), 'utf8')).toBe('today');
    expect(copyOfficeWork(o.data, 'fresh-po', o.owner)).toBeNull();
    expect(fs.readdirSync(path.dirname(o.owner))).toEqual(['owner']);
  });

  test('links the hire planted are never followed: the copy is built where the hire cannot write', () => {
    const o = office();
    const outside = path.join(o.appData, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(o.owner, 'work'), { recursive: true });
    fs.symlinkSync(outside, path.join(o.owner, 'work', 'deep'));
    fs.symlinkSync(path.join(outside, 'planted.md'), path.join(o.owner, 'work', 'triage.md'));
    fs.symlinkSync(outside, path.join(o.owner, 'work-from-office'));
    expect(copyOfficeWork(o.data, 'fresh-po', o.owner)).toBeNull();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test('what could not be queued is reported', async () => {
    const o = office();
    const summary = await importFromOffice(
      port({ createBundle: async () => ({ ok: false, why: 'not queued' }), writeOwnerNote: () => false }),
      { dataDir: o.data, handle: 'fresh-po', hireId: HIRE, role: 'product-owner', ownerDir: o.owner },
    );
    expect(summary).toMatchObject({ skills: 0, notes: 0, failed: ['skills (not queued)', 'notes/plan.md'] });
    fs.mkdirSync(path.join(o.owner, 'work-from-office', 'x'), { recursive: true });
    fs.mkdirSync(path.join(o.owner, 'work', 'x'), { recursive: true });
    const again = await importFromOffice(port(), { dataDir: o.data, handle: 'fresh-po', hireId: HIRE, role: 'product-owner', ownerDir: o.owner });
    expect(again).toMatchObject({ work: 0, failed: ['work/'] });
  });
});
