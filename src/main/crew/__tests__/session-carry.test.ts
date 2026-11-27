import { describe, expect, test } from 'bun:test';
import { carryHireSessions } from '../session-carry';
import { HIRE, crewDb } from './crew-db';

function setup() {
  const { raw, db } = crewDb();
  const thread = (key: string, session: string | null, account: string | null) =>
    raw.query(`INSERT INTO crew_thread (hire_id, thread_key, session_id, account_id) VALUES (?, ?, ?, ?)`).run(HIRE, key, session, account);
  const read = () => raw.query(`SELECT thread_key, session_id, account_id FROM crew_thread ORDER BY thread_key`).all();
  return { db, thread, read };
}

describe('carryHireSessions', () => {
  test('copies each session to the new account and falls back to fresh on a failed copy', () => {
    const { db, thread, read } = setup();
    thread('t1', 's1', 'old');
    thread('t2', 's2', 'old');
    thread('t3', null, 'old');
    thread('t4', 's4', 'gone');
    const calls: string[][] = [];
    const result = carryHireSessions(
      db,
      HIRE,
      { id: 'new', configDir: '/new' },
      (id) => (id === 'old' ? '/old' : null),
      (uuid, from, to) => {
        calls.push([uuid, from, to]);
        return uuid === 's1';
      },
    );
    expect(result).toEqual({ carried: 1, fresh: 2 });
    expect(calls).toEqual([
      ['s1', '/old', '/new'],
      ['s2', '/old', '/new'],
    ]);
    expect(read()).toEqual([
      { thread_key: 't1', session_id: 's1', account_id: 'new' },
      { thread_key: 't2', session_id: null, account_id: 'new' },
      { thread_key: 't3', session_id: null, account_id: 'new' },
      { thread_key: 't4', session_id: null, account_id: 'new' },
    ]);
  });

  test('a thread already on the account is left as it is', () => {
    const { db, thread, read } = setup();
    thread('t1', 's1', 'new');
    const result = carryHireSessions(db, HIRE, { id: 'new', configDir: '/new' }, () => '/x', () => {
      throw new Error('should not copy');
    });
    expect(result).toEqual({ carried: 0, fresh: 0 });
    expect(read()).toEqual([{ thread_key: 't1', session_id: 's1', account_id: 'new' }]);
  });
});
