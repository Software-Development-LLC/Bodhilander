/**
 * /pair — typed 6-digit code pair flow (BDHLNDR-54).
 *
 * The user runs `Pair device` on the desktop, gets a 6-digit code on
 * screen, types it here, and the desktop responds with a bearer token we
 * persist in IndexedDB. On success we redirect to /sessions.
 *
 * QR-code-driven pairing (no typing required) lands in BDHLNDR-14 and
 * will reuse the same POST body shape — `{ code, deviceName, platform }`.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';

import { ApiError, apiFetch } from '../lib/api';
import { type AuthDevice, getAuth, saveAuth } from '../lib/auth';
import { detectPlatform, suggestDeviceName } from '../lib/platform';

interface ConfirmResponse {
  token: string;
  device: {
    id: string;
    name: string;
    canControl: boolean;
    canModify: boolean;
  };
}

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string; raw?: string };

export function Pair() {
  const navigate = useNavigate();

  // If we're already paired, skip the form. Using local state instead of a
  // suspense boundary so the rest of the form renders immediately for
  // first-time users (the common case).
  const [alreadyPaired, setAlreadyPaired] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    getAuth().then((auth) => {
      if (!cancelled) setAlreadyPaired(auth !== null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const platform = useMemo(() => detectPlatform(), []);
  const [deviceName, setDeviceName] = useState(() => suggestDeviceName());
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const codeIsValid = /^\d{6}$/.test(code);
  const submitting = status.kind === 'submitting';
  const canSubmit = codeIsValid && deviceName.trim().length > 0 && !submitting;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;

    setStatus({ kind: 'submitting' });

    try {
      const res = await apiFetch<ConfirmResponse>('/pairing/confirm', {
        method: 'POST',
        body: {
          code,
          deviceName: deviceName.trim(),
          platform,
        },
      });

      // The confirm endpoint doesn't echo platform back, but we sent it,
      // so stash it in the local row so callers (settings, debug, etc.)
      // don't have to re-derive it from navigator.userAgent later.
      const device: AuthDevice = {
        id: res.device.id,
        name: res.device.name,
        platform,
        canControl: res.device.canControl,
        canModify: res.device.canModify,
      };
      await saveAuth(res.token, device);

      navigate('/sessions', { replace: true });
    } catch (err) {
      setStatus(toErrorStatus(err));
    }
  }

  if (alreadyPaired) {
    return <Navigate to="/sessions" replace />;
  }

  return (
    <main className="mx-auto max-w-md p-4">
      <h1 className="text-2xl font-semibold">Pair device</h1>
      <p className="mt-2 text-sm text-neutral-300">
        On your desktop, open Bodhilander &rarr; <em>Pair device</em> to get a
        6-digit code, then type it here.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
        <label className="block">
          <span className="text-sm font-medium text-neutral-200">Device name</span>
          <input
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            maxLength={100}
            autoComplete="off"
            className="mt-1 block w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-base text-neutral-100 outline-none focus:border-neutral-400"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-neutral-200">Pairing code</span>
          <input
            type="text"
            value={code}
            onChange={(e) => {
              // Strip anything that isn't a digit, clamp to 6.
              const next = e.target.value.replace(/\D/g, '').slice(0, 6);
              setCode(next);
            }}
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoFocus
            autoComplete="one-time-code"
            placeholder="000000"
            aria-invalid={code.length > 0 && !codeIsValid}
            className="mt-1 block w-full rounded-md border border-neutral-700 bg-neutral-800 px-3 py-3 text-center font-mono text-2xl tracking-[0.5em] text-neutral-100 outline-none focus:border-neutral-400"
          />
        </label>

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-md bg-emerald-600 px-4 py-3 text-base font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
        >
          {submitting ? 'Pairing…' : 'Pair'}
        </button>

        {status.kind === 'error' && (
          <div
            role="alert"
            className="rounded-md border border-red-700/60 bg-red-900/30 px-3 py-2 text-sm text-red-200"
          >
            <p>{status.message}</p>
            {status.raw && (
              <details className="mt-2 text-xs text-red-300/80">
                <summary className="cursor-pointer">Details</summary>
                <pre className="mt-1 whitespace-pre-wrap break-words">{status.raw}</pre>
              </details>
            )}
          </div>
        )}
      </form>
    </main>
  );
}

function toErrorStatus(err: unknown): Status {
  if (err instanceof ApiError) {
    if (err.status === 400) {
      return { kind: 'error', message: 'Invalid or expired pairing code.' };
    }
    return {
      kind: 'error',
      message: `Pairing failed (HTTP ${err.status}).`,
      raw: safeStringify(err.body) ?? err.message,
    };
  }
  // fetch() rejects with a TypeError on network failures (DNS, CORS,
  // offline, wrong host). That's the case where the desktop is unreachable.
  if (err instanceof TypeError) {
    return {
      kind: 'error',
      message:
        "Could not reach desktop — make sure you're on the same Wi-Fi or Tailscale tailnet.",
      raw: err.message,
    };
  }
  return {
    kind: 'error',
    message: 'Pairing failed.',
    raw: err instanceof Error ? err.message : String(err),
  };
}

function safeStringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
