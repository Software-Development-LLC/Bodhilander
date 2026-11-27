import React, { useEffect, useState } from 'react';
import type { ClaudeAccount, CrewHireInput, CrewHireResult, CrewRole } from '../../../shared/types';
import './Crew.css';

export interface HireModalApi {
  listRoles(): Promise<CrewRole[]>;
  listAccounts(): Promise<ClaudeAccount[]>;
  createHire(input: CrewHireInput): Promise<CrewHireResult>;
}

const windowApi = (): HireModalApi => ({
  listRoles: () => window.electronAPI.crewListRoles(),
  listAccounts: () => window.electronAPI.listAccounts(),
  createHire: (input) => window.electronAPI.crewCreateHire(input),
});

export const parseRepos = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((r) => r.trim())
    .filter((r) => r !== '');

export interface HireModalProps {
  api?: HireModalApi;
  onHired: (hireId: string) => void;
  onClose: () => void;
}

/** Hire from this machine. The Hub makes the hire and it syncs back here as provisioning. */
export const HireModal: React.FC<HireModalProps> = ({ api: injected, onHired, onClose }) => {
  const [api] = useState(() => injected ?? windowApi());
  const [roles, setRoles] = useState<CrewRole[] | null>(null);
  const [accounts, setAccounts] = useState<ClaudeAccount[]>([]);
  const [roleId, setRoleId] = useState('');
  const [name, setName] = useState('');
  const [repos, setRepos] = useState('');
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listRoles().then(setRoles, () => setRoles([]));
    api.listAccounts().then(setAccounts, () => setAccounts([]));
  }, [api]);

  const ready = roleId !== '' && name.trim() !== '' && accountId !== '' && !busy;

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.createHire({ name: name.trim(), roleId, repos: parseRepos(repos), accountId });
      if (result.hireId) onHired(result.hireId);
      else if (!result.ok) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay">
      <dialog open className="crew-hire-modal" aria-modal="true" aria-labelledby="crew-hire-title">
        <form onSubmit={(e) => void submit(e)}>
          <h3 id="crew-hire-title">Hire</h3>
          {roles?.length === 0 && <p className="crew-hire-modal__empty">No roles have synced to this machine yet.</p>}
          <label>
            Role
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">Pick a role</option>
              {(roles ?? []).map((r) => (
                <option key={r.roleId} value={r.roleId}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Repos
            <textarea value={repos} placeholder="owner/name, one per line" onChange={(e) => setRepos(e.target.value)} />
          </label>
          <label>
            Claude account
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Pick an account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p className="crew-hire-modal__error" role="alert">
              {error}
            </p>
          )}
          <div className="footer">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={!ready}>
              Hire
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
};
