/**
 * The promise the feature rests on: a restored session resumes its
 * conversation. Driven through the real functions buildAgentSpawn composes;
 * only `pty.spawn` is out of reach. Run with: bun test src/main/transfer
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { freshDb, seedSourceDb, writeTranscript } from './db-fixture';

let destination: Database;
let tmp: string;

// Registered before anything that reaches them is imported, so every module
// under test below is the real one. Both stubs match the shape the repository
// and provider suites already use for these specifiers.
mock.module('../../database', () => ({ getDatabase: () => destination }));
mock.module('electron', () => ({ app: { getPath: () => path.join(os.tmpdir(), 'bodhi-resume-userdata') } }));

const { buildTransferBundle } = await import('../bundle-export');
const { restoreTransferBundle } = await import('../bundle-import');
const { resolveAccountForSession } = await import('../../account-resolver');
const { getClaudeSessionId } = await import('../../repositories/sessions');
const { getAllAccounts } = await import('../../repositories/accounts');
const { ensureTranscriptInConfigDir, legacyClaudeConfigDir } = await import('../../conversation-transcript');
const { getProvider, CLAUDE_CONFIG_DIR_ENV } = await import('../../providers');

const SOURCE_ROOT = '/src-machine/Work/Repos';
const SOURCE_DIR = `${SOURCE_ROOT}/Bodhilander`;
const SLUG = '-src-machine-Work-Repos-Bodhilander';
const CONVERSATION = 'conv-1';
const TRANSCRIPT =
  '{"type":"user","message":{"role":"user","content":"what did we decide about the bundle format?"}}\n' +
  '{"type":"assistant","message":{"role":"assistant","content":"A manifest, the portable tables, and the transcripts."}}\n';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-resume-'));
  destination = freshDb();
});

afterEach(() => {
  destination.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a restored session resumes its conversation', () => {
  test('the CLI is handed --resume and a config dir that holds the transcript', async () => {
    const sourceConfigDir = path.join(tmp, 'src-userData', 'claude-accounts', 'acct-1', '.claude');
    const source = freshDb();
    seedSourceDb(source, { accountConfigDir: sourceConfigDir, workingDirs: [SOURCE_DIR] });
    writeTranscript(sourceConfigDir, SLUG, CONVERSATION, TRANSCRIPT);

    const { bytes } = buildTransferBundle(source as never, {
      sourceAppVersion: '3.5.1',
      sourcePlatform: 'darwin',
      sourceUserData: path.join(tmp, 'src-userData'),
      legacyConfigDir: path.join(tmp, 'src-home', '.claude'),
    });
    source.close();

    // The second machine: different userData, and the checkouts live elsewhere.
    const destAccountsRoot = path.join(tmp, 'dst-userData', 'claude-accounts');
    const destProjects = path.join(tmp, 'dst-projects');
    fs.mkdirSync(path.join(destProjects, 'Bodhilander'), { recursive: true });

    await restoreTransferBundle(destination as never, bytes, {
      accountsRoot: destAccountsRoot,
      legacyConfigDir: path.join(tmp, 'dst-home', '.claude'),
      stagingDir: path.join(tmp, 'staging'),
      mappings: [{ from: SOURCE_ROOT, to: destProjects }],
    });

    // Everything below is what buildAgentSpawn does, in the order it does it.
    const account = resolveAccountForSession('s1');
    expect(account?.configDir).toBe(path.join(destAccountsRoot, 'acct-1', '.claude'));

    const storedId = getClaudeSessionId('s1');
    expect(storedId).toBe(CONVERSATION);

    const candidates = [...new Set([legacyClaudeConfigDir(), ...getAllAccounts().map((a) => a.configDir)])];
    expect(ensureTranscriptInConfigDir(storedId!, account!.configDir, candidates)).toBe('present');

    const launch = getProvider('claude').buildCommand({
      sessionId: 's1',
      projectDir: path.join(destProjects, 'Bodhilander'),
      socketPath: path.join(tmp, 'sock'),
      agentSession: { id: storedId!, mode: 'resume' },
      configDir: account!.configDir,
    });
    expect(launch.command).toBe('claude');
    expect(launch.args).toEqual(['--resume', CONVERSATION]);
    expect(launch.env[CLAUDE_CONFIG_DIR_ENV]).toBe(account!.configDir);

    // And the bytes --resume reads are the source machine's, unchanged.
    const resolved = path.join(launch.env[CLAUDE_CONFIG_DIR_ENV]!, 'projects', SLUG, `${CONVERSATION}.jsonl`);
    expect(fs.readFileSync(resolved, 'utf-8')).toBe(TRANSCRIPT);
  });

  test('a session with no transcript is left resumable-looking but empty, not broken', async () => {
    const sourceConfigDir = path.join(tmp, 'src-userData', 'claude-accounts', 'acct-1', '.claude');
    const source = freshDb();
    seedSourceDb(source, { accountConfigDir: sourceConfigDir, workingDirs: [SOURCE_DIR] });
    fs.mkdirSync(path.join(sourceConfigDir, 'projects'), { recursive: true });

    const { bytes } = buildTransferBundle(source as never, {
      sourceAppVersion: '3.5.1',
      sourcePlatform: 'darwin',
      sourceUserData: path.join(tmp, 'src-userData'),
      legacyConfigDir: path.join(tmp, 'src-home', '.claude'),
    });
    source.close();

    const destProjects = path.join(tmp, 'dst-projects');
    fs.mkdirSync(path.join(destProjects, 'Bodhilander'), { recursive: true });
    await restoreTransferBundle(destination as never, bytes, {
      accountsRoot: path.join(tmp, 'dst-userData', 'claude-accounts'),
      legacyConfigDir: path.join(tmp, 'dst-home', '.claude'),
      stagingDir: path.join(tmp, 'staging'),
      mappings: [{ from: SOURCE_ROOT, to: destProjects }],
    });

    const account = resolveAccountForSession('s1');
    expect(ensureTranscriptInConfigDir(CONVERSATION, account!.configDir, [account!.configDir])).toBe('missing');
  });
});
