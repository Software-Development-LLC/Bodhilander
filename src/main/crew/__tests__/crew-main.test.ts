import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent/userData', getAppPath: () => process.cwd(), isPackaged: false },
  Notification: class {
    show() {}
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
  shell: { openExternal: async () => {} },
}));
const { crewDb, HIRE, PERSON, uuid } = await import('./crew-db');
const { db, raw } = crewDb();
mock.module('../../database', () => ({ getDatabase: () => db }));
mock.module('../../repositories/accounts', () => ({ getAllAccounts: () => [] }));
mock.module('../../run-engine/machine-config', () => ({ claudePath: () => 'claude', ghPath: () => 'gh' }));
const fakeHub = () => Object.assign(new EventEmitter(), {
  canStart: () => true, sendReply: () => true, sendUsage: () => true, sendEdit: () => 'e',
  audits: [] as unknown[],
  sendAudit(event: string, detail: unknown, hireId?: string) {
    this.audits.push([event, detail, hireId]);
    return 'a';
  },
});
let hub = fakeHub();
let replaced: ((h: unknown) => void) | null = null;
const events: string[] = [];
let interrupt: ((hireId: string) => void) | null = null;
mock.module('../hub-service', () => ({
  startCrewHub: () => (events.push('hub-start'), hub),
  stopCrewHub: () => events.push('hub-stop'),
  getCrewHub: () => hub,
  setCrewInterrupt: (fn: typeof interrupt) => (interrupt = fn),
  setCrewHubReplaced: (fn: typeof replaced) => (replaced = fn),
}));

const { startCrew, stopCrew } = await import('../crew-main');

describe('Crew in the main process', () => {
  test('starts the Hub and the runtime once, prepares runs for real, and stops both', async () => {
    const rt = startCrew();
    expect(startCrew()).toBe(rt);
    expect(events).toEqual(['hub-start', 'hub-start']);
    expect(typeof interrupt).toBe('function');
    raw.query(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, text) VALUES (?, ?, 1, 'owner', ?, 'hi')`).run(uuid(1), HIRE, PERSON);
    hub.emit('job', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(raw.query(`SELECT state, attempts FROM crew_job`).get()).toEqual({ state: 'queued', attempts: 0 });
    expect(raw.query(`SELECT detail FROM crew_audit WHERE event = 'run-held'`).all()).toEqual([{ detail: JSON.stringify({ jobId: uuid(1), hold: 'held:missing' }) }]);
    expect(hub.audits).toEqual([['hold', { state: 'held:missing' }, HIRE]]);
    expect(hub.listenerCount('token')).toBe(1);
    expect(hub.listenerCount('card-decision')).toBe(1);
    stopCrew();
    expect(events).toEqual(['hub-start', 'hub-start', 'hub-stop']);
    expect(interrupt).toBeNull();
    expect(hub.listenerCount('job')).toBe(0);
    expect(hub.listenerCount('token')).toBe(0);
    expect(hub.listenerCount('refused')).toBe(0);
    expect(replaced).toBeNull();
  });

  test('on Windows a run is held for setup until BodhiCrew passes its check, and the Hub is told', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      hub = fakeHub();
      raw.query(`DELETE FROM crew_job`).run();
      raw.query(`DELETE FROM crew_audit`).run();
      startCrew();
      raw.query(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, text) VALUES (?, ?, 1, 'owner', ?, 'hi')`).run(uuid(2), HIRE, PERSON);
      hub.emit('job', {});
      await new Promise((r) => setTimeout(r, 50));
      expect(raw.query(`SELECT state FROM crew_job`).get()).toEqual({ state: 'queued' });
      expect(hub.audits).toContainEqual(['hold', { state: 'held:setup' }, HIRE]);
      expect(raw.query(`SELECT event FROM crew_audit WHERE event = 'held:setup'`).all()).toEqual([{ event: 'held:setup' }]);
      stopCrew();
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  test('a replaced Hub client moves the runtime onto it', () => {
    startCrew();
    const first = hub;
    hub = fakeHub();
    replaced?.(hub);
    expect(first.listenerCount('job')).toBe(0);
    expect(hub.listenerCount('job')).toBe(1);
    stopCrew();
  });
});
