import React, { useCallback, useEffect, useState } from 'react';
import type { AccountUsageMap, ClaudeAccount, CrewEditResult, CrewHireDetail, CrewHireUsage } from '../../../shared/types';
import { DEFAULT_USAGE_WARN_THRESHOLD } from '../../../shared/usage';
import { activityText, formatTokens, hireTokenTotal, parseDailyCap } from '../../store/crew';
import { UsageMeters } from '../UsageMeters';
import './Crew.css';

export interface HireDetailApi {
  getHire(hireId: string): Promise<CrewHireDetail | null>;
  getHireUsage(hireId: string): Promise<CrewHireUsage>;
  listAccounts(): Promise<ClaudeAccount[]>;
  getAccountUsage(): Promise<AccountUsageMap>;
  setDailyCap(hireId: string, cap: number | null): Promise<CrewEditResult>;
  setRepos(hireId: string, repos: string[]): Promise<CrewEditResult>;
  changeAccount(hireId: string, accountId: string): Promise<CrewEditResult>;
  letGo(hireId: string): Promise<CrewEditResult>;
}

const windowApi = (): HireDetailApi => ({
  getHire: (id) => window.electronAPI.crewGetHire(id),
  getHireUsage: (id) => window.electronAPI.crewGetHireUsage(id),
  listAccounts: () => window.electronAPI.listAccounts(),
  getAccountUsage: () => window.electronAPI.getAccountUsage(),
  setDailyCap: (id, cap) => window.electronAPI.crewSetDailyCap(id, cap),
  setRepos: (id, repos) => window.electronAPI.crewSetRepos(id, repos),
  changeAccount: (id, accountId) => window.electronAPI.crewChangeAccount(id, accountId),
  letGo: (id) => window.electronAPI.crewLetGo(id),
});

const NOT_AVAILABLE: Record<'offline' | 'unreachable' | 'failed', string> = {
  offline: 'not available (Crew is offline)',
  unreachable: "not available (the Hub didn't answer)",
  failed: 'not available',
};

const HireTokens: React.FC<{ usage: CrewHireUsage | null }> = ({ usage }) => {
  if (usage === null) return <div className="crew-detail__tokens">Last 7 days: reading…</div>;
  const total = hireTokenTotal(usage);
  if (!usage.available || total === null) {
    const reason = usage.available ? 'failed' : usage.reason;
    return (
      <div className="crew-detail__tokens">
        Last 7 days: <span className="crew-detail__na">{NOT_AVAILABLE[reason]}</span>
      </div>
    );
  }
  return (
    <div className="crew-detail__tokens">
      Last 7 days: <strong>{formatTokens(total)}</strong>
      <dl>
        <dt>Input</dt>
        <dd>{usage.inputTokens.toLocaleString('en-US')}</dd>
        <dt>Cache creation</dt>
        <dd>{usage.cacheCreationTokens.toLocaleString('en-US')}</dd>
        <dt>Output</dt>
        <dd>{usage.outputTokens.toLocaleString('en-US')}</dd>
      </dl>
    </div>
  );
};

export interface HireDetailProps {
  hireId: string;
  api?: HireDetailApi;
  now?: () => number;
  onLetGo?: () => void;
}

const CAP_REFUSED = 'A daily cap is a whole number of tokens above 0, or empty for off.';

/** One hire: its account and usage, repos, routines, cap and skill bundle. Shows no cost. */
export const HireDetail: React.FC<HireDetailProps> = ({ hireId, api: injected, now = Date.now, onLetGo }) => {
  const [api] = useState<HireDetailApi>(() => injected ?? windowApi());
  const [hire, setHire] = useState<CrewHireDetail | null | undefined>(undefined);
  const [usage, setUsage] = useState<CrewHireUsage | null>(null);
  const [accounts, setAccounts] = useState<ClaudeAccount[]>([]);
  const [accountUsage, setAccountUsage] = useState<AccountUsageMap>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [capText, setCapText] = useState('');
  const [reposText, setReposText] = useState('');
  const [confirmingLetGo, setConfirmingLetGo] = useState(false);

  const loadHire = useCallback(async () => {
    try {
      const h = await api.getHire(hireId);
      setHire(h);
      setLoadError(null);
      if (h) {
        setCapText(h.dailyTokenCap === null ? '' : String(h.dailyTokenCap));
        setReposText(h.repos.join('\n'));
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [api, hireId]);

  useEffect(() => {
    let live = true;
    setHire(undefined);
    setUsage(null);
    setMessage(null);
    setConfirmingLetGo(false);
    void loadHire();
    api.getHireUsage(hireId).then(
      (u) => live && setUsage(u),
      () => live && setUsage({ available: false, reason: 'failed' }),
    );
    api.listAccounts().then((a) => live && setAccounts(a), () => {});
    api.getAccountUsage().then((u) => live && setAccountUsage(u), () => {});
    return () => {
      live = false;
    };
  }, [api, hireId, loadHire]);

  const apply = async (result: Promise<CrewEditResult>, done: string) => {
    try {
      const r = await result;
      setMessage(r.ok ? done : r.error);
      if (r.ok) await loadHire();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  if (loadError) return <div className="crew-detail crew-detail__error" role="alert">Couldn't read this hire: {loadError}</div>;
  if (hire === undefined) return <div className="crew-detail">Loading…</div>;
  if (hire === null) return <div className="crew-detail">This hire isn't on this machine.</div>;

  const saveCap = () => {
    const parsed = parseDailyCap(capText);
    if (!parsed.ok) return setMessage(CAP_REFUSED);
    void apply(api.setDailyCap(hire.hireId, parsed.cap), 'Cap saved.');
  };
  const saveRepos = () => {
    const repos = reposText.split('\n').map((r) => r.trim()).filter((r) => r !== '');
    void apply(api.setRepos(hire.hireId, repos), 'Repos saved.');
  };
  const letGo = async () => {
    setConfirmingLetGo(false);
    try {
      const r = await api.letGo(hire.hireId);
      if (r.ok) onLetGo?.();
      else setMessage(r.error);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="crew-detail">
      <h2>{hire.name}</h2>
      <div className="crew-detail__state">
        {hire.roleId} · {activityText(hire)}
      </div>
      {message && (
        <p className="crew-detail__hint" role="status">
          {message}
        </p>
      )}

      <section>
        <h3>Usage</h3>
        <HireTokens usage={usage} />
        {hire.accountId ? (
          <UsageMeters usage={accountUsage[hire.accountId] ?? null} threshold={DEFAULT_USAGE_WARN_THRESHOLD} now={now()} />
        ) : (
          <p className="crew-detail__hint">{hire.accountLabel ?? 'The account'} is not on this machine, so its readings can't be shown.</p>
        )}
      </section>

      <section>
        <h3>Account</h3>
        <div className="crew-detail__row">
          <label htmlFor="crew-account">Account</label>
          <select
            id="crew-account"
            value={hire.accountId ?? ''}
            onChange={(e) => e.target.value && void apply(api.changeAccount(hire.hireId, e.target.value), 'Account changed. It takes effect on the next run.')}
          >
            {hire.accountId === null && <option value="">{hire.accountLabel ?? 'None'} (missing)</option>}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section>
        <h3>Repos</h3>
        <textarea id="crew-repos" aria-label="Repos" rows={Math.max(2, hire.repos.length + 1)} value={reposText} onChange={(e) => setReposText(e.target.value)} />
        <div className="crew-detail__row">
          <button type="button" onClick={saveRepos}>
            Save repos
          </button>
          <span className="crew-detail__hint">One per line.</span>
        </div>
      </section>

      <section>
        <h3>Routines</h3>
        {hire.routines.length === 0 ? (
          <p className="crew-detail__hint">No routines.</p>
        ) : (
          <ul className="crew-detail__routines">
            {hire.routines.map((r) => (
              <li key={r.routineId}>
                <div>{r.prompt}</div>
                <div className="crew-detail__hint">
                  {r.cron} ({r.timezone}){r.lastFired === null ? '' : ` · last fired ${new Date(r.lastFired).toLocaleString()}`}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Caps</h3>
        <div className="crew-detail__row">
          <label htmlFor="crew-cap">Daily token cap</label>
          <input id="crew-cap" inputMode="numeric" placeholder="Off" value={capText} onChange={(e) => setCapText(e.target.value)} />
          <button type="button" onClick={saveCap}>
            Save cap
          </button>
          <span className="crew-detail__hint">{hire.dailyTokenCap === null ? 'Off' : formatTokens(hire.dailyTokenCap)}</span>
        </div>
      </section>

      <section>
        <h3>Skill bundle</h3>
        <div className="crew-detail__hint">
          {hire.skillBundleId} pinned at {hire.skillBundleHash.slice(0, 12)}
        </div>
      </section>

      <section>
        {confirmingLetGo ? (
          <div className="crew-detail__row">
            <button type="button" className="crew-detail__danger" onClick={() => void letGo()}>
              Let go of {hire.name}
            </button>
            <button type="button" onClick={() => setConfirmingLetGo(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="crew-detail__danger" onClick={() => setConfirmingLetGo(true)}>
            Let go…
          </button>
        )}
      </section>
    </div>
  );
};
