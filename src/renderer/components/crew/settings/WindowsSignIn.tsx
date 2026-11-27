import React, { useState } from 'react';
import type { CrewWindowsSignInResult } from '../../../../shared/types';
import '../Crew.css';

export interface WindowsSignInProps {
  accountId: string;
  label: string;
  start?: (accountId: string) => Promise<CrewWindowsSignInResult>;
  sendCode?: (code: string) => Promise<boolean>;
  cancel?: () => Promise<void>;
  onSignedIn?: () => void;
}

const REFUSED: Record<string, string> = {
  cancelled: 'Sign-in was cancelled.',
  'wrong-account': 'That sign-in was for a different Claude account. Sign in again with the account this hire uses.',
  'no-token': 'Sign-in finished without a token. Try again.',
  'no-encryption': 'This PC cannot store the sign-in securely.',
  'not-signed-in': 'Sign-in did not finish. Try again.',
  busy: 'Another sign-in is already running.',
  unavailable: "Crew's Windows setup is not ready. Finish setup first.",
};

/** Sign in a Claude account for Crew on Windows: the browser opens, and the code it shows is pasted here. */
export const WindowsSignIn: React.FC<WindowsSignInProps> = ({ accountId, label, start, sendCode, cancel, onSignedIn }) => {
  const doStart = start ?? ((id: string) => window.electronAPI.crewWindowsSignIn(id));
  const doSend = sendCode ?? ((c: string) => window.electronAPI.crewWindowsSignInCode(c));
  const doCancel = cancel ?? (() => window.electronAPI.crewWindowsSignInCancel());
  const [waiting, setWaiting] = useState(false);
  const [code, setCode] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const begin = async () => {
    setNote(null);
    setWaiting(true);
    try {
      const r = await doStart(accountId);
      setNote(r.ok ? `${label} is signed in for Crew.` : REFUSED[r.reason] ?? 'Sign-in did not finish.');
      if (r.ok) onSignedIn?.();
    } finally {
      setWaiting(false);
      setCode('');
    }
  };
  const send = async () => {
    const value = code.trim();
    if (value) await doSend(value);
  };

  return (
    <div className="crew-windows-sign-in">
      {!waiting && <button type="button" onClick={begin}>Sign in for Crew</button>}
      {waiting && (
        <>
          <p>Your browser opened to sign in {label}. When it shows a code, paste it here.</p>
          <label htmlFor="crew-windows-sign-in-code">Code</label>
          <input id="crew-windows-sign-in-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
          <button type="button" onClick={send}>Send code</button>
          <button type="button" onClick={() => void doCancel()}>Cancel</button>
        </>
      )}
      {note && <output>{note}</output>}
    </div>
  );
};
