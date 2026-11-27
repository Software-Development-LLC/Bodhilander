import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sweepSteering, wslSweepSteering } from '../steering-sweep';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function plant(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-steer-'));
  dirs.push(root);
  const put = (rel: string, body = 'x') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  put('CLAUDE.md', 'planted');
  put('CLAUDE.local.md');
  put('.claude/settings.json');
  put('notes/CLAUDE.md');
  put('notes/claude.local.md');
  put('notes/deep/.claude/settings.local.json');
  put('notes/keep.md', 'mine');
  put('notes/deep/claude-notes.md', 'mine too');
  fs.symlinkSync(path.join(root, 'notes'), path.join(root, 'link-to-notes'));
  return root;
}

const left = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      out.push(path.relative(root, p));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
};

const KEPT = ['link-to-notes', 'notes', 'notes/deep', 'notes/deep/claude-notes.md', 'notes/keep.md'];

describe('steering a run can leave behind', () => {
  test('every CLAUDE.md, CLAUDE.local.md and .claude at or below the run root goes, whatever its case; nothing else does', () => {
    const root = plant();
    sweepSteering(root);
    expect(left(root)).toEqual(KEPT);
  });

  test('a run root that does not exist yet is not an error', () => {
    expect(() => sweepSteering(path.join(os.tmpdir(), 'crew-steer-none', 'owner'))).not.toThrow();
  });

  test('the WSL command removes the same set when a shell runs it', () => {
    const root = plant();
    execFileSync('/bin/sh', ['-c', wslSweepSteering(root)]);
    expect(left(root)).toEqual(KEPT);
  });

  test('the WSL command quotes the run root', () => {
    expect(wslSweepSteering("/home/crew/a b'c")).toContain(`'/home/crew/a b'\\''c'`);
  });
});
