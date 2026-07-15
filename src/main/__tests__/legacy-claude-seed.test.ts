/**
 * Legacy-conversation seeding tests: the first registered account's config
 * dir must inherit ~/.claude/projects transcripts so pre-account sessions'
 * stored --resume UUIDs keep resolving.
 *
 * Run with: bun test src/main/__tests__
 */
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
}));

const { seedLegacyConversations } = await import('../legacy-claude-seed');

let tmp: string;
let legacyDir: string;
let configDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-seed-'));
  legacyDir = path.join(tmp, '.claude');
  configDir = path.join(tmp, 'account', '.claude');
  fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeLegacyTranscript(project: string, uuid: string): string {
  const dir = path.join(legacyDir, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, '{"type":"conversation"}\n');
  return file;
}

describe('seedLegacyConversations', () => {
  test('copies the legacy projects tree into the account config dir', async () => {
    writeLegacyTranscript('-Users-x-repo', 'aaaa-1111');
    writeLegacyTranscript('-Users-x-other', 'bbbb-2222');

    expect(await seedLegacyConversations(configDir, legacyDir)).toBe(true);

    const copied = path.join(configDir, 'projects', '-Users-x-repo', 'aaaa-1111.jsonl');
    expect(fs.existsSync(copied)).toBe(true);
    expect(fs.readFileSync(copied, 'utf-8')).toContain('conversation');
    expect(fs.existsSync(path.join(configDir, 'projects', '-Users-x-other', 'bbbb-2222.jsonl'))).toBe(true);
  });

  test('copies only projects/ — credentials and settings stay behind', async () => {
    writeLegacyTranscript('-Users-x-repo', 'aaaa-1111');
    fs.writeFileSync(path.join(legacyDir, '.credentials.json'), '{"secret":true}');
    fs.writeFileSync(path.join(legacyDir, 'settings.json'), '{}');

    await seedLegacyConversations(configDir, legacyDir);

    expect(fs.existsSync(path.join(configDir, '.credentials.json'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'settings.json'))).toBe(false);
  });

  test('no legacy projects dir → no-op', async () => {
    fs.mkdirSync(legacyDir, { recursive: true }); // .claude exists but has no projects/
    expect(await seedLegacyConversations(configDir, legacyDir)).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'projects'))).toBe(false);
  });

  test('never clobbers an existing projects dir in the target', async () => {
    writeLegacyTranscript('-Users-x-repo', 'aaaa-1111');
    const existing = path.join(configDir, 'projects', '-Users-x-mine');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'cccc-3333.jsonl'), 'mine\n');

    expect(await seedLegacyConversations(configDir, legacyDir)).toBe(false);

    expect(fs.readFileSync(path.join(existing, 'cccc-3333.jsonl'), 'utf-8')).toBe('mine\n');
    expect(fs.existsSync(path.join(configDir, 'projects', '-Users-x-repo'))).toBe(false);
  });

  test('copy failure is swallowed and reported as not seeded', async () => {
    writeLegacyTranscript('-Users-x-repo', 'aaaa-1111');
    // A file where the target dir should go makes cp fail without throwing here.
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(configDir), { recursive: true });
    fs.writeFileSync(configDir, 'not a directory');

    expect(await seedLegacyConversations(configDir, legacyDir)).toBe(false);
  });
});
