import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copyOfficeWork, findOfficeData, importFromOffice, officeEmployees, readOfficeEmployee } from '../import-office';
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

  test('sends the bundle and owner notes, copies work, and leaves Office untouched', () => {
    const o = office();
    const before = tree(o.data);
    const bundles: unknown[] = [];
    const notes: unknown[] = [];
    const summary = importFromOffice(
      { sendBundle: (...a) => (bundles.push(a), true), writeOwnerNote: (...a) => (notes.push(a), true) },
      { dataDir: o.data, handle: 'fresh-po', hireId: HIRE, role: 'product-owner', ownerDir: o.owner },
    );
    expect(summary).toEqual({ skills: 1, notes: 1, work: 2, skipped: ['skills/big/SKILL.md'], failed: [] });
    expect(bundles).toEqual([[HIRE, 'product-owner', [{ path: 'backlog-triage/SKILL.md', content: '# Triage' }]]]);
    expect(notes).toEqual([[HIRE, 'owner/plan.md', 'the plan']]);
    expect(fs.readFileSync(path.join(o.owner, 'work', 'deep', 'board.json'), 'utf8')).toBe('{}');
    expect(fs.existsSync(path.join(o.owner, 'work', 'link.txt'))).toBe(false);
    expect(tree(o.data)).toEqual(before);
  });

  test('a second copy keeps what the hire already has', () => {
    const o = office();
    expect(copyOfficeWork(o.data, 'fresh-po', o.owner)).toBe(2);
    fs.writeFileSync(path.join(o.owner, 'work', 'triage.md'), 'edited by the hire');
    expect(copyOfficeWork(o.data, 'fresh-po', o.owner)).toBe(0);
    expect(fs.readFileSync(path.join(o.owner, 'work', 'triage.md'), 'utf8')).toBe('edited by the hire');
  });

  test('what could not be queued is reported', () => {
    const o = office();
    const summary = importFromOffice(
      { sendBundle: () => false, writeOwnerNote: () => false },
      { dataDir: o.data, handle: 'fresh-po', hireId: HIRE, role: 'product-owner', ownerDir: o.owner },
    );
    expect(summary).toMatchObject({ skills: 0, notes: 0, failed: ['skills', 'notes/plan.md'] });
  });
});
