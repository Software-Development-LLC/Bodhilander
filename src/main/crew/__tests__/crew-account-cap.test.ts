import { describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';

const db = new Database(':memory:');
db.exec(`CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT)`);
mock.module('../../database', () => ({ getDatabase: () => db }));

const { DEFAULT_CREW_ACCOUNT_CAP, getCrewAccountCap, setCrewAccountCap } = await import('../../repositories/preferences');

describe('crew account cap preference', () => {
  test('defaults to 90% on both windows', () => {
    expect(getCrewAccountCap('a1')).toEqual({ fiveHourPct: 90, sevenDayPct: 90 });
    expect(DEFAULT_CREW_ACCOUNT_CAP).toEqual({ fiveHourPct: 90, sevenDayPct: 90 });
  });

  test('is set per account', () => {
    setCrewAccountCap('a1', { fiveHourPct: 50, sevenDayPct: 70 });
    expect(getCrewAccountCap('a1')).toEqual({ fiveHourPct: 50, sevenDayPct: 70 });
    expect(getCrewAccountCap('a2')).toEqual({ fiveHourPct: 90, sevenDayPct: 90 });
  });

  test('a bad stored value falls back per field, and a bad write is refused', () => {
    db.query(`INSERT OR REPLACE INTO preferences (key, value) VALUES ('crew.accountCap.a3', '{"fiveHourPct":120,"sevenDayPct":40}')`).run();
    expect(getCrewAccountCap('a3')).toEqual({ fiveHourPct: 90, sevenDayPct: 40 });
    db.query(`INSERT OR REPLACE INTO preferences (key, value) VALUES ('crew.accountCap.a4', 'nope')`).run();
    expect(getCrewAccountCap('a4')).toEqual({ fiveHourPct: 90, sevenDayPct: 90 });
    expect(() => setCrewAccountCap('a1', { fiveHourPct: -1, sevenDayPct: 50 })).toThrow();
  });
});
