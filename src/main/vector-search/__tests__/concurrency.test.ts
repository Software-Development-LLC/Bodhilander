/**
 * BDHLNDR-126 concurrency-machinery tests (#128 review): the single shared
 * embedding worker (EmbeddingService) and the global indexing serialization
 * gate/queue in VectorSearchManager. These paths exist to prevent two
 * concurrent onnxruntime InferenceSessions from crashing the process, so the
 * races they guard (cancel + same-index restart, superseded-worker exits,
 * queue draining, hung-worker timeout) are what is exercised here.
 *
 * Run with: bun test src/main/vector-search
 */
import { describe, expect, test, afterEach, mock } from 'bun:test';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Module mocks. mock.module is process-global in bun, so every stub is
// registered before the modules under test are imported (same pattern as
// src/main/__tests__/*).
// ---------------------------------------------------------------------------

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    // A fake, never-written path — the fs layer is fully mocked in these tests.
    getPath: () => '/bodhilander-test-fixtures/userdata',
  },
}));

const logStub = { info: () => {}, warn: () => {}, error: () => {} };
mock.module('electron-log', () => ({ default: logStub, ...logStub }));

mock.module('chokidar', () => ({
  watch: () => {
    const w = { on: () => w, close: () => {} };
    return w;
  },
}));

mock.module('../worker-path', () => ({
  resolveVectorSearchWorker: (name: string) => `/fake/${name}`,
}));

// embedding-provider has top-level side effects (loads @huggingface/transformers)
mock.module('../embedding-provider', () => ({ EMBEDDING_VERSION: 2 }));

/**
 * Stand-in for worker_threads.Worker. Records posted messages; `exit(code)` /
 * `msg(m)` simulate the real events. terminate() resolves after emitting
 * 'exit' asynchronously (like the real thing) unless `hung` is set, which
 * models a worker wedged in a synchronous native call that terminate()
 * cannot preempt — it never settles and never exits.
 */
class FakeWorker extends EventEmitter {
  static readonly instances: FakeWorker[] = [];
  posted: any[] = [];
  terminated = false;
  hung = false;
  stdout = null;
  stderr = null;

  constructor(
    public scriptPath: string,
    public options: any
  ) {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(m: any): void {
    this.posted.push(m);
  }

  terminate(): Promise<number> {
    if (this.hung) return new Promise(() => {});
    this.terminated = true;
    return new Promise((resolve) => {
      setImmediate(() => {
        this.emit('exit', 1);
        resolve(1);
      });
    });
  }

  exit(code: number): void {
    this.emit('exit', code);
  }

  msg(m: any): void {
    this.emit('message', m);
  }
}

mock.module('worker_threads', () => ({ Worker: FakeWorker }));

// In-memory stand-in for the code-search repository.
let indexSeq = 0;
const indexes = new Map<string, any>();
const vectorSearchCalls: any[] = [];
const repo = {
  getIndexByDirectory: (d: string) =>
    [...indexes.values()].find((i) => i.directoryPath === d) ?? null,
  createIndex: (d: string) => {
    const idx = {
      id: `idx-${++indexSeq}`,
      directoryPath: d,
      status: 'pending',
      error: null,
      fileCount: 0,
      chunkCount: 0,
      consecutiveFailures: 0,
      embeddingVersion: 2,
    };
    indexes.set(idx.id, idx);
    return idx;
  },
  getIndexById: (id: string) => indexes.get(id) ?? null,
  updateIndexStatus: (id: string, status: string, error: string | null = null) => {
    const i = indexes.get(id);
    if (i) {
      i.status = status;
      i.error = error;
    }
  },
  incrementConsecutiveFailures: (id: string) => {
    const i = indexes.get(id);
    i.consecutiveFailures = (i.consecutiveFailures ?? 0) + 1;
    return i.consecutiveFailures;
  },
  resetConsecutiveFailures: (id: string) => {
    const i = indexes.get(id);
    if (i) i.consecutiveFailures = 0;
  },
  getEmbeddingVersion: (id: string) => indexes.get(id)?.embeddingVersion ?? null,
  setEmbeddingVersion: (id: string, v: number) => {
    const i = indexes.get(id);
    if (i) i.embeddingVersion = v;
  },
  clearIndexData: (id: string, v: number) => {
    const i = indexes.get(id);
    if (i) {
      i.status = 'pending';
      i.embeddingVersion = v;
      i.chunkCount = 0;
    }
  },
  getIndexedFiles: () => [],
  updateIndexCounts: () => {},
  deleteChunksByFile: () => {},
  deleteSymbolsByFile: () => {},
  deleteIndexedFile: () => {},
  upsertIndexedFile: () => {},
  updateFileChunkCount: () => {},
  createChunk: () => {},
  createSymbol: () => ({ id: 'sym-1' }),
  searchChunksByVector: (...args: any[]) => {
    vectorSearchCalls.push(args);
    return [{ chunkId: 'c1' }];
  },
  searchSymbols: () => [],
  deleteIndex: (id: string) => {
    indexes.delete(id);
  },
};
mock.module('../../repositories/code-search', () => repo);

// Import the real EmbeddingService (against the mocked deps above), capture it
// into plain consts, THEN re-mock the module so VectorSearchManager gets a
// controllable singleton. Capturing before mock.module registers is load-
// bearing: bun retargets bindings on the module namespace once the mock is in.
const realEmbeddingModule = await import('../embedding-service');
const RealEmbeddingService = realEmbeddingModule.EmbeddingService;

let embedImpl: (texts: string[]) => Promise<number[][]> = async (t) => t.map(() => [0.1]);
let embedQueryImpl: (q: string) => Promise<number[]> = async () => [0.1];
const embedStub = {
  embed: (texts: string[]) => embedImpl(texts),
  embedQuery: (q: string) => embedQueryImpl(q),
};
mock.module('../embedding-service', () => ({
  EmbeddingService: RealEmbeddingService,
  getEmbeddingService: () => embedStub,
  disposeEmbeddingService: () => {},
}));

const { VectorSearchManager } = await import('../index');

const tick = () => new Promise<void>((r) => setImmediate(r));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const lastWorker = () => FakeWorker.instances[FakeWorker.instances.length - 1];
const DEFAULT_TIMEOUT_MS = (RealEmbeddingService as any).REQUEST_TIMEOUT_MS;

afterEach(() => {
  FakeWorker.instances.length = 0;
  indexes.clear();
  indexSeq = 0;
  vectorSearchCalls.length = 0;
  embedImpl = async (t) => t.map(() => [0.1]);
  embedQueryImpl = async () => [0.1];
  (RealEmbeddingService as any).REQUEST_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
});

// ---------------------------------------------------------------------------
// EmbeddingService — the single shared embedding worker
// ---------------------------------------------------------------------------

describe('EmbeddingService', () => {
  const embedRequest = (w: FakeWorker, i = 0) =>
    w.posted.filter((m) => m.type === 'embed')[i];

  test('resolves a request when the worker replies with embed-result', async () => {
    const svc = new RealEmbeddingService();
    const p = svc.embed(['a', 'b']);
    const w = lastWorker();
    expect(w.posted[0]).toMatchObject({ type: 'init' });
    const req = embedRequest(w);
    expect(req.texts).toEqual(['a', 'b']);
    w.msg({ type: 'embed-result', requestId: req.requestId, embeddings: [[1], [2]] });
    expect(await p).toEqual([[1], [2]]);
    svc.dispose();
  });

  test('embed-error rejects only the matching request', async () => {
    const svc = new RealEmbeddingService();
    const p1 = svc.embed(['a']);
    const p2 = svc.embed(['b']);
    const w = lastWorker();
    const [r1, r2] = [embedRequest(w, 0), embedRequest(w, 1)];
    w.msg({ type: 'embed-error', requestId: r1.requestId, error: 'boom' });
    await expect(p1).rejects.toThrow('boom');
    w.msg({ type: 'embed-result', requestId: r2.requestId, embeddings: [[9]] });
    expect(await p2).toEqual([[9]]);
    svc.dispose();
  });

  test('worker exit rejects all pending; next request respawns a fresh worker', async () => {
    const svc = new RealEmbeddingService();
    // Settle both to their error values up front — handlers must be attached
    // before the exit fires or the second rejection is flagged as unhandled
    // while the first is awaited.
    const p1 = svc.embed(['a']).catch((e: Error) => e);
    const p2 = svc.embed(['b']).catch((e: Error) => e);
    const w1 = lastWorker();
    w1.exit(1);
    expect(((await p1) as Error).message).toContain('exited (code 1)');
    expect(((await p2) as Error).message).toContain('exited (code 1)');

    const p3 = svc.embed(['c']);
    const w2 = lastWorker();
    expect(w2).not.toBe(w1);
    const req = embedRequest(w2);
    w2.msg({ type: 'embed-result', requestId: req.requestId, embeddings: [[3]] });
    expect(await p3).toEqual([[3]]);
    svc.dispose();
  });

  test('a late exit from a superseded worker cannot fail the replacement worker', async () => {
    const svc = new RealEmbeddingService();
    const p1 = svc.embed(['a']);
    const w1 = lastWorker();
    w1.exit(1);
    await expect(p1).rejects.toThrow();

    const p2 = svc.embed(['b']);
    const w2 = lastWorker();
    // 'error' and 'exit' both fire for a dying worker — replay the stale exit
    // after w2 owns the service state.
    w1.exit(1);
    const req = embedRequest(w2);
    w2.msg({ type: 'embed-result', requestId: req.requestId, embeddings: [[7]] });
    expect(await p2).toEqual([[7]]);
    svc.dispose();
  });

  test('request timeout fails pending immediately and blocks respawn until the hung worker exits', async () => {
    (RealEmbeddingService as any).REQUEST_TIMEOUT_MS = 20;
    const svc = new RealEmbeddingService();
    const p = svc.embed(['a']);
    const w1 = lastWorker();
    // Wedged in a synchronous native call: terminate() never completes and
    // 'exit' never fires on its own.
    w1.hung = true;
    await expect(p).rejects.toThrow('unresponsive');

    // The single-ONNX-session invariant: no replacement worker may spawn
    // while the wedged one is still alive — requests fail fast instead.
    await expect(svc.embed(['b'])).rejects.toThrow('temporarily unavailable');
    expect(FakeWorker.instances.length).toBe(1);

    // The wedged native call finally returns and the thread dies — service
    // recovers on the next request.
    w1.exit(1);
    const p3 = svc.embed(['c']);
    const w2 = lastWorker();
    expect(w2).not.toBe(w1);
    const req = w2.posted.find((m: any) => m.type === 'embed');
    w2.msg({ type: 'embed-result', requestId: req.requestId, embeddings: [[5]] });
    expect(await p3).toEqual([[5]]);
    svc.dispose();
  });

  test('dispose rejects pending requests', async () => {
    const svc = new RealEmbeddingService();
    const p = svc.embed(['a']);
    svc.dispose();
    await expect(p).rejects.toThrow('disposed');
  });
});

// ---------------------------------------------------------------------------
// VectorSearchManager — global serialization gate, queue, crash breaker
// ---------------------------------------------------------------------------

describe('VectorSearchManager indexing gate', () => {
  const makeManager = () => new VectorSearchManager();

  test('second directory queues behind the gate and starts when the active worker exits', async () => {
    const m = makeManager();
    await m.startIndexing('/proj/a');
    expect(FakeWorker.instances.length).toBe(1);
    const wA = lastWorker();
    expect(wA.posted[0]).toMatchObject({ type: 'start', directoryPath: '/proj/a' });

    // B (twice — the queue dedupes) while A holds the gate: no new worker.
    await m.startIndexing('/proj/b');
    await m.startIndexing('/proj/b');
    expect(FakeWorker.instances.length).toBe(1);

    // A's worker ends → gate released → B starts.
    wA.exit(0);
    await tick();
    expect(FakeWorker.instances.length).toBe(2);
    expect(lastWorker().posted[0]).toMatchObject({ type: 'start', directoryPath: '/proj/b' });

    m.dispose();
  });

  test('cancelling a queued directory removes it — the gate drain must not resurrect it', async () => {
    const m = makeManager();
    await m.startIndexing('/proj/a');
    const wA = lastWorker();
    await m.startIndexing('/proj/b');
    const idxB = repo.getIndexByDirectory('/proj/b');

    await m.cancelIndexing(idxB.id);
    wA.exit(0);
    await tick();

    // Only A's worker ever existed; B was dequeued, not started.
    expect(FakeWorker.instances.length).toBe(1);
    m.dispose();
  });

  test('cancel + immediate same-index restart: the superseded worker\'s late exit cannot release the new worker\'s gate or slot', async () => {
    const m = makeManager();
    await m.startIndexing('/proj/a');
    const idxA = repo.getIndexByDirectory('/proj/a');
    const w1 = lastWorker();

    // Cancel (removes w1 from `workers` synchronously, gate still held) and
    // restart before w1's exit fires — the same-index gate bypass.
    w1.hung = true; // hold termination so the restart truly races the exit
    const cancelPromise = m.cancelIndexing(idxA.id);
    await m.startIndexing('/proj/a');
    const w2 = lastWorker();
    expect(w2).not.toBe(w1);
    expect((m as any).activeWorker).toBe(w2);

    // The superseded worker finally exits. Identity guards must keep it from
    // deleting w2's slot, reporting a false error, or releasing w2's gate.
    w1.exit(1);
    await tick();
    expect((m as any).activeWorker).toBe(w2);
    expect((m as any).activeIndexId).toBe(idxA.id);
    expect((m as any).workers.get(idxA.id)).toBe(w2);
    expect(repo.getIndexById(idxA.id).status).toBe('indexing');
    expect(w2.terminated).toBe(false);

    // A directory queued behind the restart must stay queued (gate not freed).
    await m.startIndexing('/proj/b');
    expect(FakeWorker.instances.length).toBe(2);

    m.dispose();
    await Promise.race([cancelPromise, tick()]);
  });

  test('crash circuit breaker: repeated crashed attempts stop spawning and release the queue', async () => {
    const m = makeManager();
    const idx = repo.createIndex('/proj/crashy');
    idx.status = 'indexing'; // stale 'indexing' = previous attempt crashed the process
    idx.consecutiveFailures = 1;

    const errors: any[] = [];
    m.on('indexing-error', (e) => errors.push(e));

    await m.startIndexing('/proj/crashy');
    expect(FakeWorker.instances.length).toBe(0); // breaker tripped, no worker
    expect(repo.getIndexById(idx.id).status).toBe('error');
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('consecutive crashes');
    m.dispose();
  });

  test('embed-request from an indexing worker is brokered and answered on the same requestId', async () => {
    const m = makeManager();
    await m.startIndexing('/proj/a');
    const w = lastWorker();

    w.msg({ type: 'embed-request', requestId: 'r1', texts: ['chunk'] });
    await tick();
    expect(w.posted).toContainEqual({
      type: 'embed-response',
      requestId: 'r1',
      embeddings: [[0.1]],
    });

    embedImpl = async () => {
      throw new Error('model gone');
    };
    w.msg({ type: 'embed-request', requestId: 'r2', texts: ['chunk'] });
    await tick();
    expect(w.posted).toContainEqual({
      type: 'embed-error',
      requestId: 'r2',
      error: 'model gone',
    });
    m.dispose();
  });

  test('embed-response is not posted to a worker that was cancelled while embedding', async () => {
    const m = makeManager();
    await m.startIndexing('/proj/a');
    const idxA = repo.getIndexByDirectory('/proj/a');
    const w = lastWorker();

    const pending = deferred<number[][]>();
    embedImpl = () => pending.promise;
    w.msg({ type: 'embed-request', requestId: 'r1', texts: ['chunk'] });
    await m.cancelIndexing(idxA.id);
    const postedBefore = w.posted.length;
    pending.resolve([[0.5]]);
    await tick();
    expect(w.posted.length).toBe(postedBefore); // no reply to a dead worker
    m.dispose();
  });
});

describe('VectorSearchManager.searchCode', () => {
  const readyIndex = (dir: string) => {
    const idx = repo.createIndex(dir);
    idx.status = 'ready';
    return idx;
  };

  test('surfaces an embedding failure as an error instead of an empty result', async () => {
    const m = new VectorSearchManager();
    readyIndex('/proj/s');
    embedQueryImpl = async () => {
      throw new Error('worker exploded');
    };
    await expect(m.searchCode('/proj/s', 'query')).rejects.toThrow(
      'Semantic search is unavailable: worker exploded'
    );
    expect(vectorSearchCalls).toHaveLength(0);
    m.dispose();
  });

  test('returns vector matches when embedding succeeds', async () => {
    const m = new VectorSearchManager();
    readyIndex('/proj/s');
    const results = await m.searchCode('/proj/s', 'query');
    expect(results).toEqual([{ chunkId: 'c1' }] as any);
    expect(vectorSearchCalls).toHaveLength(1);
    m.dispose();
  });

  test('returns [] without searching when the index is not ready', async () => {
    const m = new VectorSearchManager();
    repo.createIndex('/proj/s'); // status 'pending'
    expect(await m.searchCode('/proj/s', 'query')).toEqual([]);
    expect(vectorSearchCalls).toHaveLength(0);
    m.dispose();
  });
});
