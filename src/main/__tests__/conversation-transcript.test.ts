/**
 * Launch-time transcript carry (#164).
 *
 * A switch-time copy is a snapshot: the still-running Claude keeps appending to
 * the old account's tree, so by the time the pty respawns the copy is stale and
 * the --resume fails. ensureTranscriptInConfigDir does the carry at spawn
 * instead, searching every known config dir for the newest copy.
 *
 * Mocks NOTHING — this module touches only the filesystem, which is why the
 * machinery was lifted out of account-switch.ts in the first place. Everything
 * runs against a real mkdtemp root that afterEach removes.
 *
 * Run with: bun test src/main/__tests__/conversation-transcript.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { ensureTranscriptInConfigDir } = await import('../conversation-transcript');

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-transcript-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A config dir like an account owns: <tmp>/<name>/.claude */
function configDir(name: string): string {
  const dir = path.join(tmp, name, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTranscript(dir: string, slug: string, uuid: string, body: string): string {
  const projectDir = path.join(dir, 'projects', slug);
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${uuid}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
}

/** Every file under `root`, relative — used to prove nothing was written. */
function tree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true }) as fs.Dirent[]) {
    if (entry.isFile()) out.push(path.relative(root, path.join(entry.parentPath ?? root, entry.name)));
  }
  return out.sort();
}

describe('ensureTranscriptInConfigDir', () => {
  test('reports present and copies nothing when the transcript is already in the target', () => {
    const target = configDir('target');
    const other = configDir('other');
    writeTranscript(target, '-Users-x-repo', 'uuid-1', '{"type":"here"}\n');
    const otherBefore = tree(other);

    expect(ensureTranscriptInConfigDir('uuid-1', target, [other])).toBe('present');

    // Nothing anywhere else holds this conversation, so the copy in the target
    // is trivially the newest and no write is warranted.
    expect(tree(target)).toEqual(['projects/-Users-x-repo/uuid-1.jsonl']);
    expect(tree(other)).toEqual(otherBefore);
  });

  test('the target keeps its copy when it is the newest of the candidates', () => {
    const target = configDir('target');
    const other = configDir('other');
    writeTranscript(target, '-Users-x-repo', 'uuid-1', '{"type":"current"}\n');
    const strandedFile = writeTranscript(other, '-Users-x-repo', 'uuid-1', '{"type":"stranded"}\n');
    // The copy left behind in a previously-used account is older, so the
    // freshness check must decline to write and cost one stat, not a copy.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(strandedFile, past, past);

    expect(ensureTranscriptInConfigDir('uuid-1', target, [other])).toBe('present');

    expect(
      fs.readFileSync(path.join(target, 'projects', '-Users-x-repo', 'uuid-1.jsonl'), 'utf-8'),
    ).toBe('{"type":"current"}\n');
  });

  test('a stale copy in the target loses to fresher bytes elsewhere (#164)', () => {
    const target = configDir('target');
    const source = configDir('source');
    // Exactly the switch-then-keep-working sequence. assignSessionAccount
    // copies the transcript into the new account the moment the user clicks,
    // but the pty's CLAUDE_CONFIG_DIR was baked in at spawn, so the live Claude
    // goes on appending to the OLD tree. If presence in the target counted as
    // "already carried", the restart that applies the switch would resume from
    // this snapshot and lose every turn since — #164's second symptom.
    const liveFile = writeTranscript(source, '-Users-x-repo', 'uuid-1', '{"t":1}\n{"t":2}\n');
    writeTranscript(target, '-Users-x-repo', 'uuid-1', '{"t":1}\n');
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(target, 'projects', '-Users-x-repo', 'uuid-1.jsonl'), stale, stale);

    expect(ensureTranscriptInConfigDir('uuid-1', target, [source])).toBe('carried');

    expect(
      fs.readFileSync(path.join(target, 'projects', '-Users-x-repo', 'uuid-1.jsonl'), 'utf-8'),
    ).toBe(fs.readFileSync(liveFile, 'utf-8'));
  });

  test('carries a transcript from a candidate, preserving the project slug', () => {
    const target = configDir('target');
    const source = configDir('source');
    writeTranscript(source, '-Users-x-repo', 'uuid-1', '{"type":"conversation"}\n');

    expect(ensureTranscriptInConfigDir('uuid-1', target, [source])).toBe('carried');

    const copied = path.join(target, 'projects', '-Users-x-repo', 'uuid-1.jsonl');
    expect(fs.existsSync(copied)).toBe(true);
    expect(fs.readFileSync(copied, 'utf-8')).toBe('{"type":"conversation"}\n');
  });

  test('reports missing and creates nothing when no candidate holds it', () => {
    const target = configDir('target');
    const source = configDir('source');
    writeTranscript(source, '-Users-x-repo', 'uuid-other', '{}\n');

    expect(ensureTranscriptInConfigDir('uuid-1', target, [source])).toBe('missing');

    expect(fs.existsSync(path.join(target, 'projects'))).toBe(false);
  });

  test('refuses a conversation id that is not path-safe', () => {
    const target = configDir('target');
    const source = configDir('source');
    writeTranscript(source, '-Users-x-repo', 'uuid-1', '{}\n');

    expect(ensureTranscriptInConfigDir('../../escape', target, [source])).toBe('missing');

    // Nothing escaped the target root — the property the guard exists for.
    expect(fs.existsSync(path.join(tmp, 'escape.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'escape.jsonl'))).toBe(false);
    expect(tree(target)).toEqual([]);
  });

  test('skips the target when it also appears among the candidates', () => {
    const target = configDir('target');
    const source = configDir('source');
    writeTranscript(source, '-Users-x-repo', 'uuid-1', '{"type":"conversation"}\n');

    // The caller builds candidates from "legacy + every account", so the
    // target is routinely in the list; a self-copy must not be attempted.
    expect(ensureTranscriptInConfigDir('uuid-1', target, [target, source, path.join(target, '.')]))
      .toBe('carried');
    expect(tree(target)).toEqual(['projects/-Users-x-repo/uuid-1.jsonl']);
  });

  test('an unreadable candidate does not stop the search of the rest', () => {
    const target = configDir('target');
    const broken = configDir('broken');
    const source = configDir('source');
    // projects/ as a FILE — readdir fails with ENOTDIR, the "real environment
    // problem" branch rather than the benign ENOENT one.
    fs.writeFileSync(path.join(broken, 'projects'), 'not a directory');
    writeTranscript(source, '-Users-x-repo', 'uuid-1', '{"type":"conversation"}\n');

    expect(ensureTranscriptInConfigDir('uuid-1', target, [broken, source])).toBe('carried');
    expect(
      fs.readFileSync(path.join(target, 'projects', '-Users-x-repo', 'uuid-1.jsonl'), 'utf-8'),
    ).toBe('{"type":"conversation"}\n');
  });

  test('a newer-looking but shorter file never replaces a longer one', () => {
    const target = configDir('target');
    const source = configDir('source');
    // The whole conversation, a week's work, staged where the CLI will read it.
    writeTranscript(target, '-Users-x-repo', 'uuid-1', '{"t":1}\n{"t":2}\n{"t":3}\n{"t":4}\n');
    // A stub left in another account by a brief early session, whose mtime a
    // sync-client re-download or a backup restore just bumped to now. mtime
    // says "newer"; the file says it cannot be, because a transcript for one
    // conversation id only ever grows.
    const stub = writeTranscript(source, '-Users-x-repo', 'uuid-1', '{"t":1}\n');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(stub, future, future);

    expect(ensureTranscriptInConfigDir('uuid-1', target, [source])).toBe('present');

    expect(
      fs.readFileSync(path.join(target, 'projects', '-Users-x-repo', 'uuid-1.jsonl'), 'utf-8'),
    ).toBe('{"t":1}\n{"t":2}\n{"t":3}\n{"t":4}\n');
  });

  test('with the transcript in two candidates, the most recently modified wins', () => {
    const target = configDir('target');
    const older = configDir('older');
    const newer = configDir('newer');
    const olderFile = writeTranscript(older, '-Users-x-repo', 'uuid-1', '{"type":"older"}\n');
    writeTranscript(newer, '-Users-x-repo', 'uuid-1', '{"type":"newer"}\n');
    // A previous switch left copies behind; the newest is the one Claude was
    // actually appending to.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(olderFile, past, past);

    expect(ensureTranscriptInConfigDir('uuid-1', target, [older, newer])).toBe('carried');
    expect(
      fs.readFileSync(path.join(target, 'projects', '-Users-x-repo', 'uuid-1.jsonl'), 'utf-8'),
    ).toBe('{"type":"newer"}\n');
  });
});
