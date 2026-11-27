import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent/userData', isPackaged: false },
  Notification: class {
    show() {}
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
}));
const { crewDb, HIRE, PERSON, uuid } = await import('./crew-db');
const { db, raw } = crewDb();
mock.module('../../database', () => ({ getDatabase: () => db }));
mock.module('../../repositories/accounts', () => ({ getAllAccounts: () => [] }));
mock.module('../../run-engine/machine-config', () => ({ claudePath: () => 'claude' }));
const hub = Object.assign(new EventEmitter(), {
  canStart: () => true, sendReply: () => true, sendUsage: () => true, sendEdit: () => 'e',
});
const events: string[] = [];
let interrupt: ((hireId: string) => void) | null = null;
mock.module('../hub-service', () => ({
  startCrewHub: () => (events.push('hub-start'), hub),
  stopCrewHub: () => events.push('hub-stop'),
  getCrewHub: () => hub,
  setCrewInterrupt: (fn: typeof interrupt) => (interrupt = fn),
}));

const { startCrew, stopCrew, APPROVE_BROKER_READY } = await import('../crew-main');

describe('Crew in the main process', () => {
  test('starts the Hub and the runtime once, holds runs until the approve broker is served, and stops both', async () => {
    const rt = startCrew();
    expect(startCrew()).toBe(rt);
    expect(events).toEqual(['hub-start', 'hub-start']);
    expect(typeof interrupt).toBe('function');
    expect(APPROVE_BROKER_READY).toBe(false);
    raw.query(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, text) VALUES (?, ?, 1, 'owner', ?, 'hi')`).run(uuid(1), HIRE, PERSON);
    hub.emit('job', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(raw.query(`SELECT state, attempts FROM crew_job`).get()).toEqual({ state: 'queued', attempts: 0 });
    expect(raw.query(`SELECT detail FROM crew_audit WHERE event = 'run-held'`).all()).toHaveLength(1);
    stopCrew();
    expect(events).toEqual(['hub-start', 'hub-start', 'hub-stop']);
    expect(interrupt).toBeNull();
    expect(hub.listenerCount('job')).toBe(0);
  });
});
