import React, { useCallback, useEffect, useState } from 'react';
import type { CrewHireAccount } from '../../../../shared/types';
import { WindowsSignIn, type WindowsSignInProps } from './WindowsSignIn';

type SignInSeams = Pick<WindowsSignInProps, 'start' | 'sendCode' | 'cancel'>;

export interface WindowsHireSignInProps extends SignInSeams {
  accountId: string | null;
  label: string;
  platform?: string;
  hireAccounts?: () => Promise<CrewHireAccount[]>;
}

/** A hire's account section on Windows: Sign in for Crew while its account still needs it. */
export const WindowsHireSignIn: React.FC<WindowsHireSignInProps> = ({ accountId, label, platform = window.electronAPI?.platform, hireAccounts, ...seams }) => {
  const onWindows = platform === 'win32';
  const [needs, setNeeds] = useState(false);
  const load = useCallback(() => {
    if (!onWindows || !accountId) return;
    const read = hireAccounts ?? (() => window.electronAPI.crewHireAccounts());
    read().then(
      (list) => setNeeds((list.find((a) => a.id === accountId)?.needs ?? null) !== null),
      () => setNeeds(false),
    );
  }, [onWindows, accountId, hireAccounts]);
  useEffect(load, [load]);

  if (!onWindows || !accountId || !needs) return null;
  return <WindowsSignIn accountId={accountId} label={label} onSignedIn={load} {...seams} />;
};

export interface WindowsAccountsSignInProps extends SignInSeams {
  accounts: CrewHireAccount[];
  onSignedIn: () => void;
  platform?: string;
}

/** Under Hire's account list on Windows: each account that needs Crew sign-in, with its own Sign in for Crew. */
export const WindowsAccountsSignIn: React.FC<WindowsAccountsSignInProps> = ({ accounts, onSignedIn, platform = window.electronAPI?.platform, ...seams }) => {
  const waiting = accounts.filter((a) => a.needs !== null);
  if (platform !== 'win32' || waiting.length === 0) return null;
  return (
    <ul className="crew-windows-accounts" aria-label="Accounts to sign in for Crew">
      {waiting.map((a) => (
        <li key={a.id}>
          <span>{a.label}</span>
          <WindowsSignIn accountId={a.id} label={a.label} onSignedIn={onSignedIn} {...seams} />
        </li>
      ))}
    </ul>
  );
};
