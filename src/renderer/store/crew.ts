import { useCallback, useEffect, useRef, useState } from 'react';
import type { CrewAvailability, CrewHireSummary, CrewHireUsage, CrewStatus } from '../../shared/types';

const AVAILABILITY_TEXT: Record<Exclude<CrewAvailability, 'online'>, string> = {
  connecting: 'Connecting to Crew…',
  unlinked: 'Link this machine to use Crew',
  pending: 'Waiting for the link to be approved in Teams',
  unavailable: "Crew isn't available right now",
  'update-required': 'Update Bodhilander to use Crew',
  'link-again': 'Link this machine again to use Crew',
  'key-unavailable': 'Crew needs the system keychain',
  replaced: 'Crew is connected from another window on this machine',
};

export function availabilityText(availability: CrewAvailability): string | null {
  return availability === 'online' ? null : AVAILABILITY_TEXT[availability];
}

const CAUSE_TEXT: Record<string, string> = {
  missing: 'account not on this machine',
  'signed-out': 'signed out',
  'rate-limited': 'rate limited',
  'crew-cap': 'account cap reached',
  'hire-cap': 'daily cap reached',
  setup: 'setup needs repair',
  'no-home': 'no home machine',
  backstop: 'backstop',
  rollback: 'rollback',
  'waiting-admin': 'waiting for an admin',
  failed: 'failed',
};

const cause = (c: string | null): string => (c === null ? '' : `: ${CAUSE_TEXT[c] ?? c}`);

export function activityText(hire: CrewHireSummary): string {
  switch (hire.activity) {
    case 'running':
      return 'Running';
    case 'idle':
      return 'Idle';
    case 'elsewhere':
      return 'On another machine';
    case 'held':
      return `Held${cause(hire.cause)}`;
    case 'paused':
      return `Paused${cause(hire.cause)}`;
    case 'provisioning':
      return `Setting up${cause(hire.cause)}`;
    case 'let-go':
      return 'Let go';
  }
}

export function formatTokens(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'token' : 'tokens'}`;
}

export function hireTokenTotal(usage: CrewHireUsage): number | null {
  return usage.available ? usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens : null;
}

export function parseDailyCap(text: string): { ok: true; cap: number | null } | { ok: false } {
  const trimmed = text.trim().replace(/,/g, '');
  if (trimmed === '') return { ok: true, cap: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const cap = Number(trimmed);
  return cap > 0 && Number.isSafeInteger(cap) ? { ok: true, cap } : { ok: false };
}

export interface CrewApi {
  getStatus(): Promise<CrewStatus>;
  listHires(): Promise<CrewHireSummary[]>;
  onChanged(callback: () => void): () => void;
}

const windowApi = (): CrewApi => ({
  getStatus: () => window.electronAPI.crewGetStatus(),
  listHires: () => window.electronAPI.crewListHires(),
  onChanged: (cb) => window.electronAPI.onCrewChanged(cb),
});

export interface CrewState {
  status: CrewStatus | null;
  hires: CrewHireSummary[] | null;
  error: string | null;
  refresh(): Promise<void>;
}

/** Status and hires, re-read on every change the main process pushes and on a slow poll. */
export function useCrew(api: CrewApi = windowApi(), pollMs = 15_000): CrewState {
  const [status, setStatus] = useState<CrewStatus | null>(null);
  const [hires, setHires] = useState<CrewHireSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  const refresh = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([apiRef.current.getStatus(), apiRef.current.listHires()]);
      setStatus(s);
      setHires(h);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = apiRef.current.onChanged(() => void refresh());
    const timer = setInterval(() => void refresh(), pollMs);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [refresh, pollMs]);

  return { status, hires, error, refresh };
}
