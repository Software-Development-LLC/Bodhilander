import React, { useCallback, useEffect, useRef, useState } from 'react';
import './ShareSessionModal.css';

/**
 * Offer one session to one person (docs/designs/session-sharing.md §7).
 *
 * Entry is deliberately **per-session**, not per-machine: there is no "share
 * my machine" anywhere in this feature, and the modal is shaped so the thing
 * being shared is never ambiguous.
 *
 * Only "Watch" exists in this milestone. "Watch and type" is M5.3 and is shown
 * as a disabled option rather than hidden, because the absence of a control is
 * not an explanation — and someone who wants it should learn now that it is a
 * different, heavier decision rather than discovering later that it silently
 * appeared.
 */

const HOUR = 3600;

/** Invite lifetime — how long the link works if nobody uses it. */
const INVITE_TTL_OPTIONS = [
  { label: '15 minutes', seconds: 15 * 60 },
  { label: '1 hour', seconds: HOUR },
  { label: '1 day', seconds: 24 * HOUR },
];

/**
 * Grant lifetime — how long access lasts once they join.
 *
 * "Until I revoke it" is 0, not a very large number: it is a different answer
 * to the question, not a longer one. Someone watching a session alongside
 * their own work should not lose it mid-afternoon and have to be re-invited,
 * and re-issuing a link every few hours buys nothing — revoking is instant,
 * and restarting the shared session ends the share on its own.
 */
const GRANT_TTL_OPTIONS = [
  { label: '1 hour', seconds: HOUR },
  { label: '4 hours', seconds: 4 * HOUR },
  { label: '8 hours', seconds: 8 * HOUR },
  { label: 'Until I revoke it', seconds: 0 },
];

interface ShareSessionModalProps {
  sessionId: string | null;
  sessionName: string;
  onClose: () => void;
}

type Created = { code: string; url: string; expiresAt: number };

export const ShareSessionModal: React.FC<ShareSessionModalProps> = ({ sessionId, sessionName, onClose }) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const loginRef = useRef<HTMLInputElement>(null);
  const [login, setLogin] = useState('');
  const [openLink, setOpenLink] = useState(false);
  const [inviteTtl, setInviteTtl] = useState(HOUR);
  const [grantTtl, setGrantTtl] = useState(4 * HOUR);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (sessionId) {
      if (!dialog.open) dialog.showModal();
      setLogin('');
      setOpenLink(false);
      setCreated(null);
      setError(null);
      setCopied(false);
      setTimeout(() => loginRef.current?.focus(), 50);
    }
  }, [sessionId]);

  const handleCancel = useCallback(
    (e: React.SyntheticEvent<HTMLDialogElement>) => {
      e.preventDefault();
      onClose();
    },
    [onClose],
  );

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!sessionId || busy) return;
      setBusy(true);
      setError(null);
      try {
        const result = await window.electronAPI.relayCreateShare({
          sessionId,
          expectedGithubLogin: openLink ? null : login.trim(),
          role: 'viewer',
          grantTtlSeconds: grantTtl,
          inviteTtlSeconds: inviteTtl,
        });
        setCreated(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not create the invite.');
      } finally {
        setBusy(false);
      }
    },
    [sessionId, busy, openLink, login, grantTtl, inviteTtl],
  );

  const copy = useCallback(async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.url);
    setCopied(true);
  }, [created]);

  if (!sessionId) return null;

  // Not `??`: these are booleans, and `??` would short-circuit on `false`
  // rather than falling through to the handle check. Written as a branch so
  // the intent is explicit either way.
  const hasLogin = login.trim().length > 0;
  const canSubmit = openLink ? true : hasLogin;

  return (
    <dialog
      ref={dialogRef}
      className="share-session-modal"
      aria-labelledby="share-session-title"
      onCancel={handleCancel}
    >
      <h3 id="share-session-title">{created ? 'Send this link' : `Share “${sessionName}”`}</h3>

      {created ? (
        <div className="share-created">
          <label className="share-field-label" htmlFor="share-url">
            Link
          </label>
          <input id="share-url" className="share-url" readOnly value={created.url} onFocus={(e) => e.target.select()} />

          <p className="share-code">
            or read out the code: <strong>{created.code}</strong>
          </p>

          {/* The link IS the credential — anyone holding it who also satisfies
              the addressing can ask to join. Say so plainly rather than
              trusting people to infer it. */}
          <p className="share-warning">
            🔑 This link is the key. Send it over something private.
          </p>

          <p className="share-note">
            {openLink
              ? 'Anyone with this link can ask to join. You still have to let them in.'
              : `Only @${login.trim()} can use this link. You still have to let them in.`}
          </p>

          {/* Stated on the confirmation too: this is the one choice that keeps
              running after the owner has stopped thinking about it. */}
          {grantTtl === 0 && (
            <p className="share-note">
              Access lasts until you revoke it — or until this session restarts.
            </p>
          )}

          <div className="share-buttons">
            <button type="button" className="share-secondary" onClick={onClose}>
              Done
            </button>
            <button type="button" className="share-primary" onClick={copy}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <fieldset className="share-fieldset">
            <legend className="share-field-label">Who&apos;s it for?</legend>
            <div className="share-login-row">
              <span className="share-at">@</span>
              <input
                ref={loginRef}
                className="share-login"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                placeholder="github-username"
                disabled={openLink}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <p className="share-hint">Only this GitHub account can use the link.</p>
            <label className="share-checkbox">
              <input type="checkbox" checked={openLink} onChange={(e) => setOpenLink(e.target.checked)} />
              <span>Or make an open link (anyone with it can ask)</span>
            </label>
          </fieldset>

          <fieldset className="share-fieldset">
            <legend className="share-field-label">What can they do?</legend>
            <label className="share-radio">
              <input type="radio" checked readOnly />
              <strong>Watch</strong>
              <em>They see this session&apos;s live output. They can&apos;t type.</em>
            </label>
            {/* Shown disabled rather than hidden: the absence of a control is
                not an explanation, and this is a materially heavier decision
                than the one above. */}
            <label className="share-radio share-radio-disabled">
              <input type="radio" disabled />
              <strong>Watch and type</strong>
              <em>Not available yet — it hands over your whole environment, so it needs its own consent step.</em>
            </label>
          </fieldset>

          <fieldset className="share-fieldset">
            <legend className="share-field-label">How long?</legend>
            {/* Two clocks, stated separately, because they mean different
                things and collapsing them into one number would be a lie. */}
            <div className="share-ttl-row">
              <label htmlFor="share-invite-ttl">The link works for</label>
              <select id="share-invite-ttl" value={inviteTtl} onChange={(e) => setInviteTtl(Number(e.target.value))}>
                {INVITE_TTL_OPTIONS.map((o) => (
                  <option key={o.seconds} value={o.seconds}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="share-hint">if nobody uses it</span>
            </div>
            <div className="share-ttl-row">
              <label htmlFor="share-grant-ttl">Once they join, access lasts</label>
              <select id="share-grant-ttl" value={grantTtl} onChange={(e) => setGrantTtl(Number(e.target.value))}>
                {GRANT_TTL_OPTIONS.map((o) => (
                  <option key={o.seconds} value={o.seconds}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="share-hint">{grantTtl === 0 ? 'ends when you say so' : 'you can end it sooner'}</span>
            </div>
          </fieldset>

          {error && (
            <p className="share-error" role="alert">
              {error}
            </p>
          )}

          <div className="share-buttons">
            <button type="button" className="share-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="share-primary" disabled={!canSubmit || busy}>
              {busy ? 'Creating…' : 'Create link'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
};
