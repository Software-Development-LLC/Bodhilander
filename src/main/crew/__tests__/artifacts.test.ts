import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
  ArtifactError, IMAGE_MISMATCH, IMAGE_UNAVAILABLE, MAX_URLS_PER_DOWNLOAD, downloadArtifact, isPinnedSha, parseVersions, requestArtifactUrl, validArtifactName,
  type ArtifactAnswer, type DownloadDeps, type HttpAnswer,
} from '../artifacts';

const IMAGE = Buffer.from('a rootfs image, in three pieces');
const SHA = createHash('sha256').update(IMAGE).digest('hex');

function memFs(start: Buffer = Buffer.alloc(0)) {
  const files = new Map<string, Buffer>();
  if (start.length) files.set('/dl/img', start);
  return {
    files,
    size: (f: string) => files.get(f)?.length ?? null,
    async *read(f: string) {
      yield files.get(f) ?? Buffer.alloc(0);
    },
    append: (f: string, c: Uint8Array) => void files.set(f, Buffer.concat([files.get(f) ?? Buffer.alloc(0), Buffer.from(c)])),
    truncate: (f: string) => void files.set(f, Buffer.alloc(0)),
    remove: (f: string) => void files.delete(f),
  };
}

async function* chunks(buf: Buffer, failAfter?: number) {
  for (let i = 0; i < buf.length; i += 10) {
    if (failAfter !== undefined && i >= failAfter) throw new Error('reset');
    yield buf.subarray(i, i + 10);
  }
}

function deps(over: Partial<DownloadDeps> & { answers?: ArtifactAnswer[]; replies?: Array<(from: number) => HttpAnswer> } = {}) {
  const requests: string[] = [];
  const gets: Array<{ url: string; from: number }> = [];
  const answers = over.answers ?? [{ url: 'https://blob/1?sig', expiresAt: 1000 }];
  const replies = over.replies ?? [(from: number) => ({ status: from ? 206 : 200, body: chunks(IMAGE.subarray(from)) })];
  let clock = 0;
  const d: DownloadDeps & { requests: string[]; gets: typeof gets; tick(n: number): void } = {
    requests,
    gets,
    tick: (n) => void (clock = n),
    request: async (name) => {
      requests.push(name);
      return answers[Math.min(requests.length - 1, answers.length - 1)];
    },
    get: async (url, from) => {
      gets.push({ url, from });
      return replies[Math.min(gets.length - 1, replies.length - 1)](from);
    },
    fs: memFs(),
    now: () => clock,
    ...(({ answers: _a, replies: _r, ...rest }) => rest)(over),
  };
  return d;
}

const spec = { name: 'rootfs/ubuntu.tar.gz', sha256: SHA, file: '/dl/img' };

describe('versions.json', () => {
  test('the shipped file parses, and its blob name passes the Hub pattern', () => {
    const raw = fs.readFileSync(path.join(__dirname, '../../../../resources/crew-agent/versions.json'), 'utf8');
    const v = parseVersions(raw);
    expect(validArtifactName(v.rootfs.name)).toBe(true);
    expect(v.node.version.startsWith('24.')).toBe(true);
  });

  test('names with a dot-dot segment or a leading separator are refused', () => {
    expect(validArtifactName('a/../b')).toBe(false);
    expect(validArtifactName('/abs')).toBe(false);
    expect(validArtifactName('ok/name-1.tar')).toBe(true);
  });

  test('a placeholder hash is never pinned', () => {
    expect(isPinnedSha('NOT-VERIFIED-rootfs-sha256-placeholder')).toBe(false);
    expect(isPinnedSha(SHA)).toBe(true);
  });
});

describe('the artifact request', () => {
  class Hub extends EventEmitter {
    sent: Array<{ id: string; name: string }> = [];
    open = true;
    sendArtifactRequest(id: string, name: string) {
      this.sent.push({ id, name });
      return this.open;
    }
  }

  test('answers the URL for its own id and name', async () => {
    const hub = new Hub();
    const p = requestArtifactUrl(hub, 'rootfs/x');
    const { id } = hub.sent[0];
    hub.emit('artifact', { type: 'artifact', id: 'other', name: 'rootfs/x', url: 'https://wrong', expiresAt: 1 });
    hub.emit('artifact', { type: 'artifact', id, name: 'rootfs/x', url: 'https://blob?sig', expiresAt: 9 });
    expect(await p).toEqual({ url: 'https://blob?sig', expiresAt: 9 });
    expect(hub.listenerCount('artifact')).toBe(0);
  });

  test('a plain-http URL or another name is refused', async () => {
    const hub = new Hub();
    const p = requestArtifactUrl(hub, 'rootfs/x');
    hub.emit('artifact', { type: 'artifact', id: hub.sent[0].id, name: 'rootfs/x', url: 'http://blob', expiresAt: 9 });
    expect(await p).toEqual({ refused: 'malformed' });
  });

  test('refused, offline and unanswered all come back without a URL', async () => {
    const hub = new Hub();
    const p = requestArtifactUrl(hub, 'rootfs/x');
    hub.emit('refused', { type: 'refused', id: hub.sent[0].id, reason: 'unknown' });
    expect(await p).toEqual({ refused: 'unknown' });

    const offline = new Hub();
    offline.open = false;
    expect(await requestArtifactUrl(offline, 'rootfs/x')).toBeNull();

    const quiet = new Hub();
    const timers = { setTimeout: (cb: () => void) => (queueMicrotask(cb), 1), clearTimeout: () => {} };
    expect(await requestArtifactUrl(quiet, 'rootfs/x', timers)).toBeNull();
  });
});

describe('downloadArtifact', () => {
  test('streams and checks the image', async () => {
    const d = deps();
    const progress: number[] = [];
    d.onProgress = (n) => progress.push(n);
    expect(await downloadArtifact(d, spec)).toBe('/dl/img');
    expect((d.fs as ReturnType<typeof memFs>).files.get('/dl/img')).toEqual(IMAGE);
    expect(progress.at(-1)).toBe(IMAGE.length);
  });

  test('a mismatch deletes the file and installs nothing', async () => {
    const d = deps();
    const err = await downloadArtifact(d, { ...spec, sha256: 'f'.repeat(64) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArtifactError);
    expect((err as ArtifactError).message).toBe(IMAGE_MISMATCH);
    expect((d.fs as ReturnType<typeof memFs>).files.has('/dl/img')).toBe(false);
  });

  test('a placeholder hash never starts a download', async () => {
    const d = deps();
    const err = await downloadArtifact(d, { ...spec, sha256: 'NOT-VERIFIED-x' }).catch((e: unknown) => e);
    expect((err as ArtifactError).failure).toBe('unavailable');
    expect(d.requests).toEqual([]);
  });

  test('an unlinked PC or a refused name changes nothing', async () => {
    for (const answer of [null, { refused: 'unknown' }] as ArtifactAnswer[]) {
      const d = deps({ answers: [answer] });
      const err = await downloadArtifact(d, spec).catch((e: unknown) => e);
      expect((err as ArtifactError).message).toBe(IMAGE_UNAVAILABLE);
      expect(d.gets).toEqual([]);
    }
  });

  test('a cut after the URL expired asks for a new URL and resumes with Range', async () => {
    const d = deps({
      answers: [{ url: 'https://blob/1', expiresAt: 5 }, { url: 'https://blob/2', expiresAt: 50 }],
      replies: [() => ({ status: 200, body: chunks(IMAGE, 20) }), (from) => ({ status: 206, body: chunks(IMAGE.subarray(from)) })],
    });
    const real = d.fs.append;
    d.fs.append = (f, c) => {
      real(f, c);
      if (((d.fs as ReturnType<typeof memFs>).files.get(f)?.length ?? 0) >= 20) d.tick(10);
    };
    await downloadArtifact(d, spec);
    expect(d.gets).toEqual([{ url: 'https://blob/1', from: 0 }, { url: 'https://blob/2', from: 20 }]);
    expect((d.fs as ReturnType<typeof memFs>).files.get('/dl/img')).toEqual(IMAGE);
  });

  test('a cut before expiry is a download error, not a new URL', async () => {
    const d = deps({ replies: [() => ({ status: 200, body: chunks(IMAGE, 10) })] });
    const err = await downloadArtifact(d, spec).catch((e: unknown) => e);
    expect((err as ArtifactError).failure).toBe('download');
    expect(d.requests.length).toBe(1);
  });

  test('a 403 asks for a new URL, at most ten in all', async () => {
    const d = deps({ answers: [{ url: 'https://blob/n', expiresAt: 99 }], replies: [() => ({ status: 403, body: chunks(Buffer.alloc(0)) })] });
    const err = await downloadArtifact(d, spec).catch((e: unknown) => e);
    expect((err as ArtifactError).failure).toBe('download');
    expect(d.requests.length).toBe(MAX_URLS_PER_DOWNLOAD);
  });

  test('a partial from an earlier attempt is re-hashed and resumed', async () => {
    const d = deps({ fs: memFs(IMAGE.subarray(0, 12)) });
    await downloadArtifact(d, spec);
    expect(d.gets[0].from).toBe(12);
    expect((d.fs as ReturnType<typeof memFs>).files.get('/dl/img')).toEqual(IMAGE);
  });

  test('a server ignoring Range restarts the file from zero', async () => {
    const d = deps({ fs: memFs(Buffer.from('garbage-bytes')), replies: [() => ({ status: 200, body: chunks(IMAGE) })] });
    await downloadArtifact(d, spec);
    expect((d.fs as ReturnType<typeof memFs>).files.get('/dl/img')).toEqual(IMAGE);
  });
});
