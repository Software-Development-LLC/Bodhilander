import { getDatabase } from '../database';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

export function getPreference(key: string): string | null {
  const db = getDatabase();
  const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setPreference(key: string, value: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO preferences (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function deletePreference(key: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM preferences WHERE key = ?').run(key);
}

export function getWindowBounds(): WindowBounds | null {
  const value = getPreference('windowBounds');
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function setWindowBounds(bounds: WindowBounds): void {
  setPreference('windowBounds', JSON.stringify(bounds));
}

export interface CrewAccountCap {
  fiveHourPct: number;
  sevenDayPct: number;
}

export const DEFAULT_CREW_ACCOUNT_CAP: CrewAccountCap = { fiveHourPct: 90, sevenDayPct: 90 };

const crewAccountCapKey = (accountId: string): string => `crew.accountCap.${accountId}`;

const isPct = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

/** Above either reported window's cap, no new Crew run starts on the account. */
export function getCrewAccountCap(accountId: string): CrewAccountCap {
  const value = getPreference(crewAccountCapKey(accountId));
  if (!value) return { ...DEFAULT_CREW_ACCOUNT_CAP };
  try {
    const parsed = JSON.parse(value) as Partial<CrewAccountCap>;
    return {
      fiveHourPct: isPct(parsed.fiveHourPct) ? parsed.fiveHourPct : DEFAULT_CREW_ACCOUNT_CAP.fiveHourPct,
      sevenDayPct: isPct(parsed.sevenDayPct) ? parsed.sevenDayPct : DEFAULT_CREW_ACCOUNT_CAP.sevenDayPct,
    };
  } catch {
    return { ...DEFAULT_CREW_ACCOUNT_CAP };
  }
}

export function setCrewAccountCap(accountId: string, cap: CrewAccountCap): void {
  if (!isPct(cap.fiveHourPct) || !isPct(cap.sevenDayPct)) throw new Error('a Crew cap is a percent from 0 to 100');
  setPreference(crewAccountCapKey(accountId), JSON.stringify(cap));
}
