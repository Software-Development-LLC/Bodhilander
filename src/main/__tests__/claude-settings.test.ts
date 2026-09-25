/**
 * Workspace-trust seeding (CO-722, gate-workspace-trust).
 *
 * A `--bg` gate in a folder whose trust prompt hasn't been accepted exits 1
 * ("Workspace not trusted"), and every run cuts a fresh, untrusted worktree.
 * `ensureWorkspaceTrusted` sets `projects[<cwd>].hasTrustDialogAccepted: true` in
 * the account's `.claude.json` before launch. The load-bearing properties: it
 * PRESERVES the rest of that large state file, is idempotent, and REFUSES to
 * overwrite a file it cannot parse (clobbering Claude Code's own state would be
 * the worst outcome).
 *
 * Run with: bun test src/main/__tests__/claude-settings.test.ts
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureWorkspaceTrusted, getClaudeJsonPath } from '../claude-settings';

let cfg = '';
const CWD = 'C:/work/repos/_wt-co-999-service-api';
const readJson = () => JSON.parse(fs.readFileSync(getClaudeJsonPath(cfg), 'utf-8'));
const writeJson = (v: unknown) => fs.writeFileSync(getClaudeJsonPath(cfg), JSON.stringify(v, null, 2));

beforeEach(() => {
  cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-trust-')) + '/.claude';
  fs.mkdirSync(cfg, { recursive: true });
});
afterEach(() => {
  const root = path.dirname(cfg);
  if (root.includes('bodhi-trust-')) fs.rmSync(root, { recursive: true, force: true });
});

describe('ensureWorkspaceTrusted', () => {
  test('a fresh config dir (no .claude.json) gets the folder trusted', () => {
    expect(ensureWorkspaceTrusted(cfg, CWD)).toBe(true);
    expect(readJson().projects[CWD].hasTrustDialogAccepted).toBe(true);
  });

  test('preserves other top-level keys and other projects', () => {
    writeJson({
      oauthAccount: { emailAddress: 'me@x.com' },
      machineId: 'abc123',
      projects: { 'C:/other/repo': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } },
    });

    expect(ensureWorkspaceTrusted(cfg, CWD)).toBe(true);

    const after = readJson();
    // The new folder is trusted...
    expect(after.projects[CWD].hasTrustDialogAccepted).toBe(true);
    // ...and nothing else was disturbed.
    expect(after.oauthAccount.emailAddress).toBe('me@x.com');
    expect(after.machineId).toBe('abc123');
    expect(after.projects['C:/other/repo']).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Bash'] });
  });

  test('keeps an existing project entry\'s other fields when trusting it', () => {
    writeJson({ projects: { [CWD]: { hasTrustDialogAccepted: false, allowedTools: ['Read'] } } });

    ensureWorkspaceTrusted(cfg, CWD);

    expect(readJson().projects[CWD]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Read'] });
  });

  test('is idempotent: already trusted makes no write', () => {
    writeJson({ projects: { [CWD]: { hasTrustDialogAccepted: true } } });
    const before = fs.readFileSync(getClaudeJsonPath(cfg), 'utf-8');

    expect(ensureWorkspaceTrusted(cfg, CWD)).toBe(true);

    expect(fs.readFileSync(getClaudeJsonPath(cfg), 'utf-8')).toBe(before);
  });

  test('REFUSES to overwrite a .claude.json it cannot parse', () => {
    const raw = '{ this is not valid json ';
    fs.writeFileSync(getClaudeJsonPath(cfg), raw);

    expect(ensureWorkspaceTrusted(cfg, CWD)).toBe(false);
    // The real state file is left exactly as it was, not clobbered.
    expect(fs.readFileSync(getClaudeJsonPath(cfg), 'utf-8')).toBe(raw);
  });

  test('leaves no temp file behind (temp + atomic rename)', () => {
    ensureWorkspaceTrusted(cfg, CWD);
    expect(fs.readdirSync(cfg).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  test('a WINDOWS backslash cwd is stored under the forward-slash key that --bg reads', () => {
    // The bug that made #371 ineffective: Claude Code normalizes trust keys to
    // forward slashes internally, so a backslash key never matches for --bg.
    expect(ensureWorkspaceTrusted(cfg, 'C:\\work\\repos\\_wt-co-1-service-api')).toBe(true);
    const projects = readJson().projects;
    expect(projects['C:/work/repos/_wt-co-1-service-api'].hasTrustDialogAccepted).toBe(true);
    expect(projects['C:\\work\\repos\\_wt-co-1-service-api']).toBeUndefined();
  });

  test('idempotent across the slash forms (backslash input recognises a forward-slash entry)', () => {
    writeJson({ projects: { 'C:/work/repos/_wt-co-2-service-api': { hasTrustDialogAccepted: true } } });
    const before = fs.readFileSync(getClaudeJsonPath(cfg), 'utf-8');

    expect(ensureWorkspaceTrusted(cfg, 'C:\\work\\repos\\_wt-co-2-service-api')).toBe(true);

    expect(fs.readFileSync(getClaudeJsonPath(cfg), 'utf-8')).toBe(before);
  });
});
