import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));

const { checkAndRead } = await import('../send-file');
const { crewTools } = await import('../server');
const { sendFileAccess } = await import('../../run/sandbox-settings');
import { hirePaths } from '../../run/scope';
import type { RunScope } from '../../protocol';
import type { FileAnswer, FileInput } from '../../hub-client';
import { HIRE, PERSON, crewDb, uuid } from '../../__tests__/crew-db';
import { markTainted } from '../../taint';

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function machine(scope: RunScope) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'send-file-')));
  made.push(base);
  const userData = path.join(base, 'userData');
  const paths = hirePaths(userData, HIRE);
  const account = path.join(base, 'claude-accounts', 'a1', '.claude');
  for (const d of [paths.owner, paths.circle, path.join(paths.owner, 'work'), account, path.join(userData, 'crew', 'other-hire')]) fs.mkdirSync(d, { recursive: true });
  const credentials = path.join(account, '.credentials.json');
  fs.writeFileSync(credentials, '{"secret":"x"}');
  fs.writeFileSync(path.join(paths.owner, 'work', 'x.md'), 'owner only');
  fs.writeFileSync(path.join(paths.circle, 'report.md'), 'for the circle');
  const access = sendFileAccess({
    paths,
    scope,
    configDir: account,
    accountDirs: [account],
    userData,
    userDataEntries: fs.readdirSync(userData),
    crewEntries: fs.readdirSync(path.join(userData, 'crew')),
    home: path.join(base, 'home'),
    sockets: [],
    socketRoot: '',
    allowedDomains: [],
  });
  return { base, paths, credentials, access };
}

describe('send_file paths', () => {
  test('a circle run cannot reach owner/ through ..', () => {
    const m = machine('circle');
    expect(checkAndRead('../owner/work/x.md', m.access)).toMatchObject({ ok: false });
    expect(checkAndRead(path.join(m.paths.owner, 'work', 'x.md'), m.access)).toMatchObject({ ok: false });
  });

  test('an owner run reads owner/ and circle/, and the bytes, size and sha256 are the file\'s', () => {
    const m = machine('owner');
    const r = checkAndRead('work/x.md', m.access);
    expect(r).toMatchObject({ ok: true, file: { name: 'x.md', size: 10, sha256: createHash('sha256').update('owner only').digest('hex') } });
    expect(checkAndRead('../circle/report.md', m.access)).toMatchObject({ ok: true });
  });

  for (const scope of ['owner', 'circle'] as const) {
    test(`a ${scope} run is refused a symlink and a hard link to .credentials.json made in its cwd`, () => {
      const m = machine(scope);
      const cwd = scope === 'owner' ? m.paths.owner : m.paths.circle;
      fs.symlinkSync(m.credentials, path.join(cwd, 'soft.json'));
      fs.linkSync(m.credentials, path.join(cwd, 'hard.json'));
      expect(checkAndRead('soft.json', m.access)).toEqual({ ok: false, reason: 'send_file does not send links.' });
      expect(checkAndRead('hard.json', m.access)).toEqual({ ok: false, reason: 'send_file does not send a file with more than one link.' });
      expect(checkAndRead(m.credentials, m.access)).toMatchObject({ ok: false });
    });
  }

  test('a symlink anywhere in the path is refused, even to a file the run could read', () => {
    const m = machine('circle');
    fs.mkdirSync(path.join(m.paths.circle, 'real'));
    fs.writeFileSync(path.join(m.paths.circle, 'real', 'a.md'), 'a');
    fs.symlinkSync(path.join(m.paths.circle, 'real'), path.join(m.paths.circle, 'via'));
    expect(checkAndRead('via/a.md', m.access)).toEqual({ ok: false, reason: 'send_file does not send links.' });
    expect(checkAndRead('real/a.md', m.access)).toMatchObject({ ok: true });
  });

  test('a file swapped for a symlink, or for another file, between the check and the read is refused', () => {
    const m = machine('circle');
    const target = path.join(m.paths.circle, 'report.md');
    const toLink = checkAndRead('report.md', m.access, {
      beforeOpen: () => {
        fs.unlinkSync(target);
        fs.symlinkSync(m.credentials, target);
      },
    });
    expect(toLink).toEqual({ ok: false, reason: 'The file changed while it was being checked.' });
    fs.unlinkSync(target);
    fs.writeFileSync(target, 'again');
    const toOther = checkAndRead('report.md', m.access, {
      beforeOpen: () => {
        fs.writeFileSync(`${target}.new`, '{"secret":"x"}');
        fs.renameSync(`${target}.new`, target);
      },
    });
    expect(toOther).toEqual({ ok: false, reason: 'The file changed while it was being checked.' });
  });

  test('a file over 25 MB is refused before it is read', () => {
    const m = machine('circle');
    const big = path.join(m.paths.circle, 'big.bin');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 26 * 1024 * 1024);
    let opened = false;
    expect(checkAndRead('big.bin', m.access, { beforeOpen: () => (opened = true) })).toEqual({ ok: false, reason: 'A file sent with send_file is at most 25 MB.' });
    expect(opened).toBe(false);
  });

  test('a directory, a missing file and an empty path are refused', () => {
    const m = machine('circle');
    fs.mkdirSync(path.join(m.paths.circle, 'd'));
    expect(checkAndRead('d', m.access)).toMatchObject({ ok: false });
    expect(checkAndRead('nope.md', m.access)).toMatchObject({ ok: false, reason: 'No such file.' });
    expect(checkAndRead('', m.access)).toMatchObject({ ok: false });
  });
});

describe('send_file tool', () => {
  function tool(scope: RunScope, answer: FileAnswer = { state: 'ack' }) {
    const m = machine(scope);
    const { raw, db } = crewDb();
    raw.query(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, text) VALUES (?, ?, 1, ?, ?, 'hi')`).run(uuid(1), HIRE, scope, PERSON);
    const sent: [string, FileInput][] = [];
    const tools = crewTools(
      {
        db,
        raiseCard: () => true,
        sendMessage: () => true,
        writeNote: () => true,
        fileAccess: () => m.access,
        sendFile: async (jobId, file) => (sent.push([jobId, file]), answer),
        newId: () => uuid(60),
      },
      { id: uuid(1), hireId: HIRE, scope },
      `chat:${scope}`,
    );
    return { m, db, raw, sent, call: (args: Record<string, unknown>) => tools.call('send_file', args) };
  }

  test('nothing reaches the Hub when a check refuses, and the refusal is audited', async () => {
    const t = tool('circle');
    fs.symlinkSync(t.m.credentials, path.join(t.m.paths.circle, 'soft.json'));
    for (const p of ['../owner/work/x.md', 'soft.json']) expect((await t.call({ path: p })).isError).toBe(true);
    expect(t.sent).toEqual([]);
    expect(t.raw.query(`SELECT COUNT(*) AS n FROM crew_audit WHERE event = 'send-file-refused'`).get()).toEqual({ n: 2 });
  });

  test('the bytes read go to the Hub with send\'s target, and the Hub\'s answer comes back to the run', async () => {
    const t = tool('circle');
    const r = await t.call({ path: 'report.md' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('Sent report.md');
    expect(t.sent).toHaveLength(1);
    const [jobId, file] = t.sent[0];
    expect(jobId).toBe(uuid(1));
    expect({ ...file, bytes: Buffer.from(file.bytes).toString() }).toEqual({ id: uuid(60), name: 'report.md', size: 14, sha256: createHash('sha256').update('for the circle').digest('hex'), bytes: 'for the circle', tainted: false, inboundId: uuid(1) });
  });

  test('a file to someone outside the circle names its recipient, and a tainted run marks every file tainted for the Hub\'s card', async () => {
    const t = tool('circle');
    markTainted(t.db, HIRE, 'chat:circle', 'web_fetch:https://x.example/');
    await t.call({ path: 'report.md', recipient: 'stranger@other.example' });
    expect(t.sent[0][1]).toMatchObject({ recipient: 'stranger@other.example', tainted: true });
    expect(t.sent[0][1].inboundId).toBeUndefined();
    expect((await t.call({ path: 'report.md', recipient: 'no-at-sign' })).isError).toBe(true);
  });

  test('a refusal and a missing answer are reported as such', async () => {
    expect((await tool('circle', { state: 'refused', reason: 'scope' }).call({ path: 'report.md' })).content[0].text).toContain('refused');
    expect((await tool('circle', { state: 'pending' }).call({ path: 'report.md' })).content[0].text).toContain('queued');
  });

  test('with no file access, as on Windows, send_file is refused', async () => {
    const { raw, db } = crewDb();
    raw.query(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, text) VALUES (?, ?, 1, 'owner', ?, 'hi')`).run(uuid(1), HIRE, PERSON);
    const tools = crewTools({ db, raiseCard: () => true, sendMessage: () => true, writeNote: () => true, fileAccess: () => null, sendFile: async () => ({ state: 'ack' }) }, { id: uuid(1), hireId: HIRE, scope: 'owner' }, 't');
    expect((await tools.call('send_file', { path: 'x' })).isError).toBe(true);
  });
});
