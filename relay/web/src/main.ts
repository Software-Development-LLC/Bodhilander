import './styles.css';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { RelayConnection, type ConnState, type Inner } from './connection';
import { createReconnectScheduler, readyCommands } from './reconnect';
import { clearAccountState, INVITE_STASH } from './account';
import { endedCopy } from './ended';
import {
  autoOpenSessionId,
  machineLabel,
  machineMenuTitle,
  machineSections,
  planArrival,
  showSectionTitles,
  type Arrival,
} from './arrival';
import {
  connectionProblemCopy,
  FIT_ACTION,
  fitAskedCopy,
  guestSubtitle,
  offlineCopy,
  waitingCopy,
  wideBannerCopy,
} from './guest-copy';
import {
  confirmCopy,
  guestShareRows,
  ownerShareRows,
  revokeDoneCopy,
  revokeFailedCopy,
  type ShareRow,
  type WireMyShare,
  type WireShareGrant,
  type WireShareInvite,
} from './shares';

// ---------------------------------------------------------------------------
// Types (mirror the agent's sealed payloads)
// ---------------------------------------------------------------------------
type SessionState = 'idle' | 'working' | 'waiting' | 'error' | 'stopped';
interface RSession { id: string; name: string; state: SessionState; groupId: string; workingDir: string; provider: string; shellType: string; }
interface RGroup { id: string; name: string; color: string; workingDir: string; parentId: string | null; }
interface Machine {
  id: string;
  name: string;
  ed25519Pub: string;
  lastSeenAt: number | null;
  /** How you reach it. Guests get a certificate; owners get null. */
  relation?: 'owner' | 'grantee';
  /** Label by PERSON for a guest — "machine" is owner vocabulary. */
  ownerName?: string | null;
  grantId?: string | null;
  role?: string | null;
  certificate?: string | null;
}

interface Me {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  /** The handle the RELAY holds, which may be null — see the account sheet. */
  githubLogin: string | null;
}

/** True when the signed-in user is a guest on the machine they are viewing. */
const isGuest = () => app.machine?.relation === 'grantee';

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
function h(tag: string, attrs: Record<string, string> = {}, html?: string): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (html !== undefined) el.innerHTML = html;
  return el;
}
const esc = (s: string) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
/**
 * `esc()` serializes a TEXT node, and the HTML spec does not escape quotes
 * there — only `&`, `<`, `>` and nbsp. That is safe between tags and unsafe
 * inside a quoted attribute, where a `"` in the value ends the attribute and
 * everything after it is parsed as markup. Display names and avatar URLs both
 * arrive from GitHub, so attribute interpolation uses this instead.
 */
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const api = (path: string, init?: RequestInit) => fetch(path, { credentials: 'same-origin', ...init });

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const root = document.documentElement;
const savedTheme = localStorage.getItem('theme');
if (savedTheme) root.setAttribute('data-theme', savedTheme);
function isDark() { const t = root.getAttribute('data-theme'); return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; }
function toggleTheme() { const d = !isDark(); root.setAttribute('data-theme', d ? 'dark' : 'light'); localStorage.setItem('theme', d ? 'dark' : 'light'); applyTermTheme(); }

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const app = { conn: null as RelayConnection | null, user: null as Me | null, machine: null as Machine | null, machines: [] as Machine[], sessions: [] as RSession[], groups: [] as RGroup[], activeId: null as string | null, fp: '', fpVerified: false, devLogin: false, arrival: null as Arrival<Machine> | null, landed: false };
const rootEl = document.getElementById('root')!;

// history-layer nav so Back works within the app
const layers: Array<() => void> = [];
function pushLayer(close: () => void) { layers.push(close); history.pushState({ n: layers.length }, ''); }
window.addEventListener('popstate', () => { const c = layers.pop(); if (c) c(); });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  try {
    const cfg = (await api('/api/config').then((r) => (r.ok ? r.json() : {})).catch(() => ({}))) as { devLogin?: boolean };
    app.devLogin = !!cfg.devLogin;

    const invite = inviteCodeFromPath();
    const me = await api('/api/me');
    if (!me.ok) {
      // Stash the whole location before OAuth. The fragment carries the
      // machine fingerprint and does NOT survive a redirect round trip, so
      // without this the guest comes back unable to check provenance and we
      // would have to either lie about it or nag them.
      if (invite) sessionStorage.setItem(INVITE_STASH, location.pathname + location.hash);
      return renderSignIn(!!invite);
    }
    app.user = ((await me.json().catch(() => ({}))) as { user?: Me }).user ?? null;

    // Back from OAuth on an invite link.
    const stashed = sessionStorage.getItem(INVITE_STASH);
    if (!invite && stashed) {
      sessionStorage.removeItem(INVITE_STASH);
      history.replaceState(null, '', stashed);
      return boot();
    }
    if (invite) {
      sessionStorage.removeItem(INVITE_STASH);
      return renderRedeem(invite);
    }

    const { machines } = await api('/api/machines').then((r) => r.json());
    renderApp(machines as Machine[]);
  } catch {
    renderSignIn();
  }
}

// ---------------------------------------------------------------------------
// Invite redemption (/i/:code)
// ---------------------------------------------------------------------------

function inviteCodeFromPath(): string | null {
  const m = /^\/i\/([^/]+)\/?$/.exec(location.pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** The fingerprint the sender put in the link, if any. */
function invitedFingerprint(): string | null {
  const m = /(?:^|&)fp=([^&]+)/.exec(location.hash.replace(/^#/, ''));
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * Copy for each way an invite can fail. Never guesses.
 *
 * `reauth` marks the one failure the person reading it can actually fix, and
 * gets a button rather than a sentence telling them to go and do it.
 */
const REDEEM_COPY: Record<string, { title: string; body: string; reauth?: boolean; switchAccount?: boolean }> = {
  invite_not_found: { title: "That link doesn't work", body: 'Check you copied all of it, or ask for a new one.' },
  invite_expired: { title: 'That link has expired', body: 'Ask for a new one — links stop working after a while on purpose.' },
  invite_already_used: { title: 'That link has been used', body: 'Invite links work once. Ask for a new one.' },
  invite_revoked: { title: 'That link was cancelled', body: 'Whoever sent it withdrew the invitation.' },
  invite_wrong_account: {
    title: "This link isn't for this account",
    body: 'It was addressed to a specific GitHub account. Sign in as that account, or ask for a link addressed to you.',
    switchAccount: true,
  },
  invite_own_machine: { title: "That's your own machine", body: 'You already have full access to it — no invite needed.' },
  invite_login_unknown: {
    title: "One more sign-in and you're in",
    body:
      "This link is addressed to a GitHub account, and we don't have your handle on file yet — signing in again " +
      'fetches it and brings you straight back here.',
    reauth: true,
  },
};

async function renderRedeem(code: string): Promise<void> {
  // A full-page screen, not a bottom sheet: `.sheet` is max-height:88dvh with
  // no sticky footer, so on a small phone the primary action lands below the
  // fold — on the one screen where the primary action is the entire point.
  rootEl.innerHTML = `<div class="screen-center"><div class="card-center">
    <div class="logo">🤝</div><h1>Joining…</h1>
    <div class="spinner" style="margin:18px auto"></div>
  </div></div>`;

  let res: Response;
  try {
    res = await api('/api/shares/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch {
    rootEl.innerHTML = `<div class="screen-center"><div class="card-center">
      <div class="logo">📡</div><h1>Couldn't reach the server</h1>
      <p>Check your connection and try again.</p>
      <button class="btn" onclick="location.reload()">Try again</button>
    </div></div>`;
    return;
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const copy = REDEEM_COPY[body.error ?? ''] ?? {
      title: "That link didn't work",
      body: 'Ask whoever sent it for a new one.',
    };
    rootEl.innerHTML = `<div class="screen-center"><div class="card-center">
      <div class="logo">${copy.reauth ? '🔑' : '🚫'}</div><h1>${esc(copy.title)}</h1>
      <p>${esc(copy.body)}</p>
      ${copy.reauth ? '<button class="btn gh" id="reauth">Sign in with GitHub</button>' : ''}
      ${copy.switchAccount ? '<button class="btn gh" id="switchAcct">Sign in as another account</button>' : ''}
      <a class="btn ghost" href="/">Go to my machines</a>
    </div></div>`;
    // Stash the invite the same way the signed-out path does, so OAuth returns
    // to this link — with its fingerprint fragment — instead of the home page.
    // From the path that means keeping the fragment: it carries the machine fingerprint and
    // does not survive the OAuth round trip on its own. From a typed code there
    // is no fragment, so rebuild the link from the code itself rather than
    // stashing whatever page they happened to be on.
    const returnTo = () =>
      inviteCodeFromPath() === code ? location.pathname + location.hash : `/i/${encodeURIComponent(code)}`;

    const reauth = $('#reauth');
    if (reauth) {
      reauth.onclick = () => {
        sessionStorage.setItem(INVITE_STASH, returnTo());
        location.href = '/auth/github/login';
      };
    }
    // Addressed to someone else. Re-running OAuth would silently hand back the
    // same account, so this one has to end the session first — otherwise the
    // copy above tells them to do something the app gives them no way to do.
    const switchAcct = $<HTMLButtonElement>('#switchAcct');
    if (switchAcct) {
      switchAcct.onclick = () =>
        void signOut({ to: '/auth/github/login', stashInvite: returnTo(), btn: switchAcct });
    }
    return;
  }

  const grant = (await res.json().catch(() => ({}))) as { grant?: { id?: string } };
  history.replaceState(null, '', '/');
  renderWaitingForApproval(grant.grant?.id ?? null);
}

/**
 * The most-travelled path in the whole feature, and the guest's entire first
 * impression. It must say what is happening, that it is normal, and what to
 * do — a spinner alone reads as broken.
 *
 * The person is named as soon as we know who they are, which is not at
 * redemption: `/api/machines` lists only countersigned grants, so the owner's
 * name comes from the guest's own share list instead. Until it lands the copy
 * says the same thing without inventing a name.
 */
function renderWaitingForApproval(grantId: string | null): void {
  const paint = (ownerName: string | null) => {
    const copy = waitingCopy(ownerName);
    rootEl.innerHTML = `<div class="screen-center"><div class="card-center">
      <div class="logo">⏳</div>
      <h1>${esc(copy.title)}</h1>
      <p>${esc(copy.body)}</p>
      <div class="spinner" style="margin:18px auto"></div>
      <button class="btn ghost" id="checkNow">Check now</button>
    </div></div>`;
    $('#checkNow')!.onclick = () => void pollForGrant(true);
  };
  paint(null);
  // Repaint only if this screen is still the one on show — the owner may have
  // answered while the lookup was in flight, and the terminal must not be
  // replaced by a waiting screen that is no longer true.
  if (grantId) void nameTheOwner(grantId).then((name) => { if (name && $('#checkNow')) paint(name); });
  void pollForGrant(false);
}

/** Who the guest is waiting on, from their own share list. Null if unknown. */
async function nameTheOwner(grantId: string): Promise<string | null> {
  try {
    const res = await api('/api/shares');
    if (!res.ok) return null;
    const body = (await res.json()) as { grants: WireMyShare[] };
    return body.grants.find((g) => g.id === grantId)?.ownerName ?? null;
  } catch {
    return null;
  }
}

let waitTimer: ReturnType<typeof setTimeout> | null = null;

/** Poll until the owner answers. Cheap, and stops the moment it resolves. */
async function pollForGrant(immediate: boolean): Promise<void> {
  if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
  try {
    const { machines } = (await api('/api/machines').then((r) => r.json())) as { machines: Machine[] };
    if (machines.some((m) => m.relation === 'grantee')) return renderApp(machines);
  } catch {
    /* transient — keep waiting rather than declaring failure */
  }
  waitTimer = setTimeout(() => void pollForGrant(false), immediate ? 1500 : 4000);
}

function renderSignIn(fromInvite = false) {
  rootEl.innerHTML = `
    <div class="screen-center"><div class="card-center">
      <div class="logo">${fromInvite ? '🤝' : '🛰️'}</div>
      <h1>${fromInvite ? "You've been invited" : 'Bodhilander Remote'}</h1>
      <p>${
        fromInvite
          ? 'Sign in with GitHub to accept. The invitation may be addressed to a specific account.'
          : "Reach your desktop's sessions from anywhere — end-to-end encrypted."
      }</p>
      <a class="btn gh" href="/auth/github/login">Sign in with GitHub</a>
      ${app.devLogin ? '<button class="btn ghost" id="dev" style="margin-top:10px">Dev sign in</button>' : ''}
      ${new URLSearchParams(location.search).get('denied') === 'org' ? '<div class="banner err">Access is restricted to authorized members.</div>' : ''}
    </div></div>`;
  const dev = $('#dev'); if (dev) dev.onclick = async () => { await api('/dev/login', { method: 'POST' }); location.href = '/'; };
}

// ---------------------------------------------------------------------------
// Main app shell
// ---------------------------------------------------------------------------
function renderApp(machines: Machine[]) {
  app.machines = machines;
  if (!machines.length) {
    // Two different empty states. Telling someone who was invited to a session
    // to go and generate a link code in a desktop app they do not have is
    // advice for a completely different person.
    rootEl.innerHTML = `<div class="screen-center"><div class="card-center">
      <div class="logo">🖥️</div><h1>Nothing here yet</h1>
      <p>If someone shared a session with you, open the link they sent. If this is your own machine, open
         <b>Settings → Remote Hosting → Generate link code</b> in the desktop app.</p>
      <button class="btn" id="inviteBtn">Enter an invite code</button>
      <button class="btn ghost" style="margin-top:10px" id="linkBtn">Link my own machine</button>
      <button class="btn ghost" style="margin-top:10px" onclick="location.reload()">Refresh</button>
      ${accountFooter()}
    </div></div>`;
    $('#linkBtn')!.onclick = openLinkMachine;
    // "Nothing here yet" is exactly what the wrong account looks like, so this
    // screen of all of them must offer a way out of the identity you're in.
    const out = $<HTMLButtonElement>('#emptyOut');
    if (out) out.onclick = () => void signOut({ btn: out });
    // Posts to /api/shares/redeem, never /link/claim — the latter would
    // attempt an ownership transfer, which is a completely different act.
    $('#inviteBtn')!.onclick = () => {
      const code = prompt('Enter the invite code you were sent');
      if (code?.trim()) void renderRedeem(code.trim());
    };
    return;
  }
  // Pick the last machine the user chose here, else the first. A machine
  // switcher (the pill) lets them change it or link another — except for the
  // single-grant guest, who is offered neither: choosing between one thing is
  // not a choice, and "machine" is owner vocabulary anyway. They were invited
  // to a session by a person, so that is where they land.
  app.arrival = planArrival(machines, localStorage.getItem('bodhi.machineId'));
  app.machine = app.arrival!.machine;
  app.landed = false;
  // No pill at all for the single-grant guest: it would be a switcher with
  // nothing to switch to, over a word ("machine") that describes a
  // relationship they don't have. The connection state reaches them through
  // the terminal's own strip instead — that is the pane they land on.
  const pill = app.arrival!.showPicker
    ? `<button class="machine-pill" id="machineBtn"><span class="dot off" id="mdot"></span> <span>${esc(
        machineLabel(app.machine),
      )}</span></button>`
    : '';

  rootEl.innerHTML = `
  <div class="app">
    <section class="pane list-pane" aria-label="Sessions">
      <header class="bar">
        <div class="brand grow"><span class="logo">🛰️</span> <span>Bodhilander</span></div>
        <button class="iconbtn" id="theme" aria-label="Toggle light/dark theme">◐</button>
        ${accountButton()}
      </header>
      <div class="pill-row">${pill}<button class="sharebtn" id="shareBtn"><span aria-hidden="true">🤝</span> ${isGuest() ? 'Your access' : 'Sharing'}</button></div>
      <div class="list-head"><h2>Sessions</h2><span class="attn-count hidden" id="attn"></span></div>
      <ul class="sessions" id="sessions"><li class="empty-note"><div class="spinner"></div><p style="margin-top:14px">Connecting securely…</p></li></ul>
      <button class="fab" id="fab" aria-label="New session">＋</button>
      <div class="foot"><span class="lock">🔒 End-to-end encrypted</span> <span>·</span> <button id="fpBtn" style="color:var(--muted);font-family:var(--mono);font-size:11.5px">fingerprint</button></div>
    </section>
    <section class="pane term-pane" aria-label="Terminal">
      <header class="bar">
        <button class="back" id="back" aria-label="Back to sessions"><span class="chev" aria-hidden="true">‹</span> Sessions</button>
        <div class="term-title grow"><div class="t-name" id="tName">—</div><div class="t-meta" id="tMeta"></div></div>
        <button class="iconbtn" id="fpBtn2" aria-label="Connection details">🔒</button>
      </header>
      <div class="conn-strip hidden" id="connStrip" role="status"></div>
      <div class="screen" id="screen"></div>
      <div class="compose">
        <div class="attn-banner hidden" id="attnBanner">✻ This session is waiting for your response</div>
        <div class="keys" id="keys" role="toolbar" aria-label="Terminal keys"></div>
        <div class="input-row">
          <textarea id="ta" rows="1" placeholder="Message this session…  (⏎ sends)" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
          <button class="send" id="send" aria-label="Send" disabled>➤</button>
        </div>
      </div>
    </section>
    <div class="sheet-scrim" id="fpSheet"></div>
    <div class="sheet-scrim" id="createSheet"></div>
    <div class="sheet-scrim" id="newGroupSheet"></div>
  </div>`;

  $('#theme')!.onclick = toggleTheme;
  $('#acct')!.onclick = openAccount;
  $('#fab')!.onclick = openCreate;
  $('#fpBtn')!.onclick = openFp; $('#fpBtn2')!.onclick = openFp;
  const machineBtn = $('#machineBtn');
  if (machineBtn) machineBtn.onclick = openMachineMenu;
  $('#shareBtn')!.onclick = () => (isGuest() ? openMyShares() : openSharing());
  $('#back')!.onclick = () => history.back();
  if (isGuest()) {
    applyWatchOnly();
    // Creating sessions belongs to no guest role, so the button could only
    // ever produce a refusal. Offering it is a promise the machine will break.
    $('#fab')?.remove();
  } else { buildKeys(); setupCompose(); }
  connect();
}

/**
 * Turn the terminal pane into an honest read-only surface.
 *
 * Watch-only is never expressed by absence alone. Removing the compose bar
 * and leaving a blank gap reads as broken or as a feature that failed to
 * load; a person needs to be told what they CAN do, not left to infer what
 * they cannot.
 */
function applyWatchOnly(): void {
  const compose = $('.compose');
  if (compose) {
    // Occupies the compose bar's place so an upgrade to typing swaps in
    // without the layout jumping.
    compose.className = 'compose watch-only';
    compose.innerHTML = `
      <div class="attn-banner hidden" id="attnBanner">✻ This session is waiting for a response</div>
      <div class="watch-strip" role="status">
        <span aria-hidden="true">👁</span>
        <span>Watch only. You can read and scroll this session. You can't type into it.</span>
      </div>`;
  }

  const screen = $('#screen');
  if (!screen) return;
  // Focusable and announced read-only, so a keyboard or screen-reader user
  // reaches the content at all — the pane is the entire point of the page.
  screen.setAttribute('tabindex', '0');
  screen.setAttribute('role', 'document');
  screen.setAttribute('aria-readonly', 'true');
  screen.setAttribute('aria-label', 'Shared terminal output, read only');

  // The existing scroll path is a touch-only touchmove handler, so without
  // this a keyboard user cannot move through the scrollback at all.
  screen.addEventListener('keydown', (ev) => {
    if (!term) return;
    const page = Math.max(1, term.rows - 1);
    if (ev.key === 'PageUp') { term.scrollLines(-page); ev.preventDefault(); }
    else if (ev.key === 'PageDown') { term.scrollLines(page); ev.preventDefault(); }
    else if (ev.key === 'Home') { term.scrollToTop(); ev.preventDefault(); }
    else if (ev.key === 'End') { term.scrollToBottom(); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { term.scrollLines(-1); ev.preventDefault(); }
    else if (ev.key === 'ArrowDown') { term.scrollLines(1); ev.preventDefault(); }
  });
}

/**
 * How long the "asked" state stands before the ask is offered again. The
 * owner may not have been at their desk, and a button claiming a request is
 * still live forever is a worse lie than letting someone ask twice.
 */
const FIT_ASK_MS = 45_000;
let fitAskedAt = 0;
let wideBannerKey = '';

/**
 * Tell a guest their view is wider than their screen, whose screen it is
 * sized for, and offer the one thing they can do about it. Without this the
 * horizontal cut-off reads as a rendering bug.
 */
function updateWideBanner(screenEl: HTMLElement): void {
  const id = 'wideBanner';
  const cols = term?.cols ?? 0;
  const overflows = screenEl.scrollWidth > screenEl.clientWidth + 4;
  let banner = document.getElementById(id);

  if (!overflows || !cols) {
    // It fits — which is also what an accepted request looks like from here.
    banner?.remove();
    wideBannerKey = '';
    fitAskedAt = 0;
    return;
  }
  if (!banner) {
    banner = h('div', { id, class: 'wide-banner', role: 'status' });
    screenEl.parentElement?.insertBefore(banner, screenEl);
    wideBannerKey = '';
  }
  const owner = app.machine?.ownerName ?? null;
  const asked = Date.now() - fitAskedAt < FIT_ASK_MS;
  // Rebuilt only when it would actually read differently: this runs on every
  // resize and every terminal:size, and replacing the markup underneath a
  // finger takes the button away mid-press.
  const key = `${asked}|${cols}|${owner ?? ''}`;
  if (key === wideBannerKey) return;
  wideBannerKey = key;
  banner.innerHTML = `<span class="wide-text">${esc(asked ? fitAskedCopy(owner) : wideBannerCopy(owner, cols))}</span>${
    asked ? '' : `<button class="fitbtn" id="fitBtn">${esc(FIT_ACTION)}</button>`
  }`;
  const fit = $<HTMLButtonElement>('#fitBtn');
  if (fit) fit.onclick = requestFit;
}

/**
 * Ask the owner to resize this session to fit our screen. A guest never sends
 * `terminal:resize` — their phone must not reflow somebody else's terminal.
 * A declined request changes nothing here, so the copy promises nothing.
 */
function requestFit(): void {
  if (!term || !fitAddon || !app.activeId) return;
  const dims = fitAddon.proposeDimensions();
  if (!dims?.cols || !dims.rows || !isFinite(dims.cols) || !isFinite(dims.rows)) return;
  app.conn?.command({ type: 'terminal:resize-request', sessionId: app.activeId, cols: dims.cols, rows: dims.rows });
  fitAskedAt = Date.now();
  const refresh = () => { const el = $<HTMLElement>('#screen'); if (el) updateWideBanner(el); };
  refresh();
  setTimeout(refresh, FIT_ASK_MS + 500); // unanswered long enough — offer the ask again
}

// ---------------------------------------------------------------------------
// Connection + presence
// ---------------------------------------------------------------------------
function connect() {
  const conn = new RelayConnection(app.machine!.id, app.machine!.ed25519Pub, app.machine!.certificate ?? null);
  app.conn = conn;
  conn.onFingerprint = (fp, ok) => { app.fp = fp; app.fpVerified = ok; };
  conn.onState = (s: ConnState, detail?: string) => onConnState(s, detail);
  conn.onMessage = (m) => onAgentMessage(m);
  // A refused command is a fact about that command, not about your access.
  conn.onCommandDenied = (command) => {
    // eslint-disable-next-line no-console
    console.warn('[relay] command refused by the machine:', command || '(unknown)');
  };
  conn.connect();
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastSessionsJson = '';
// Whether the relay last said this machine's agent is connected. The sharing
// sheet's after-revoke copy hangs on it: "disconnected now" and "lands when it
// reconnects" are different claims, and only one of them is true at a time.
let machineOffline = false;
function startPolling() { stopPolling(); pollTimer = setInterval(() => app.conn?.command({ type: 'sessions:list' }), 2500); }
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// Re-open the channel after a delay. Used both when the socket drops (`closed`)
// and when the agent is `offline` — in the offline case the relay keeps our
// socket open but won't route until the desktop connects, so without this the
// view stays stuck on "offline" until a manual refresh even after the machine
// comes online. Retrying makes it recover on its own within a few seconds.
const reconnector = createReconnectScheduler({
  isAlive: () => app.conn != null, // false ⇒ deliberate teardown, don't resurrect
  reconnect: () => { app.conn?.close(); connect(); },
});

function renderEnded(reason: string): void {
  // The words live in ended.ts, where the sealed-only attribution rule is
  // pinned by tests; a close-derived ending can only reach the neutral copy.
  const copy = endedCopy(reason);
  stopPolling();
  reconnector.cancel();
  app.conn?.close();
  app.conn = null;
  rootEl.innerHTML = `<div class="screen-center"><div class="card-center">
    <div class="logo">${copy.icon}</div>
    <h1>${esc(copy.title)}</h1>
    <p>${esc(copy.body)}</p>
    <a class="btn ghost" href="/">Go to my machines</a>
  </div></div>`;
}

/**
 * The connection's state where a guest can actually see it: one who landed
 * straight in the terminal never looks at the session list, so that pane's
 * empty note reaches nobody. Empty text hides the strip rather than gap it.
 */
function setConnStrip(text: string | null): void {
  const strip = $('#connStrip');
  if (!strip) return;
  strip.textContent = text ?? '';
  strip.classList.toggle('hidden', !text);
}

function onConnState(s: ConnState, detail?: string) {
  if (s === 'denied') return renderEnded(detail ?? 'revoked');
  const dot = $('#mdot'); const list = $('#sessions');
  if (s === 'ready') {
    machineOffline = false;
    reconnector.cancel();
    setConnStrip(null);
    dot?.classList.remove('off');
    // Including the open terminal's subscription: a reconnect is a new socket
    // and the agent's new client session has none, so without re-asking the
    // page reads connected while nothing arrives on it ever again.
    for (const c of readyCommands(app.activeId)) app.conn!.command(c);
    startPolling(); // keep the list live (new/removed sessions + state changes)
  } else if (s === 'offline') {
    machineOffline = true;
    stopPolling(); dot?.classList.add('off');
    // Whose machine it is, and that we keep asking — a guest cannot go and
    // look at the desktop, so "it'll appear here" is advice for its owner.
    const offline = offlineCopy(isGuest(), app.machine?.ownerName);
    if (list) list.innerHTML = `<li class="empty-note"><div style="font-size:28px">🌙</div><p>${esc(offline)}</p></li>`;
    setConnStrip(offline);
    reconnector.schedule(3000); // agent not connected yet — keep polling until it appears
  } else if (s === 'error') {
    // A hard error (e.g. identity-verification failure) should surface, not retry.
    // Cancel any reconnect queued by a prior offline/closed so it can't fire on top.
    reconnector.cancel();
    stopPolling(); dot?.classList.add('off');
    const problem = connectionProblemCopy(isGuest(), app.machine?.ownerName, detail);
    if (list) list.innerHTML = `<li class="empty-note"><div style="font-size:28px">⚠️</div><p>${esc(problem)}</p></li>`;
    setConnStrip(problem);
  } else if (s === 'closed') {
    stopPolling(); dot?.classList.add('off');
    setConnStrip('Reconnecting…');
    reconnector.schedule(3000); // socket dropped — reconnect
  }
}

function onAgentMessage(m: Inner) {
  if (m.type === 'groups') { app.groups = (m.groups as RGroup[]) || []; renderSessions(); if ($('#gtree')) { buildCreateTree(); } return; }
  if (m.type === 'dirs') { onDirs?.({ path: String(m.path), entries: (m.entries as string[]) || [] }); return; }
  if (m.type === 'sessions') {
    const list = (m.sessions as RSession[]) || [];
    const j = JSON.stringify(list);
    if (j === lastSessionsJson) return; // unchanged — skip re-render (avoid flicker)
    lastSessionsJson = j;
    app.sessions = list;
    renderSessions();
    maybeLandInTerminal();
    updateTermHeader(); // keep the open terminal's state chip / attention banner live
    return;
  }
  if (m.type === 'terminal:size') {
    // The PTY's authoritative size. Mirror it exactly (rendering a different grid
    // than the PTY clamps Claude's cursor moves and garbles output). With dynamic
    // sizing this is usually the size WE just reported, so the terminal fits the
    // pane 1:1; when the desktop owns a bigger size, scaleTerm shrinks it to fit.
    if (m.sessionId === app.activeId && term) {
      term.resize(Math.max(2, Number(m.cols) || 80), Math.max(2, Number(m.rows) || 24));
      scaleTerm();
    }
    return;
  }
  if (m.type === 'terminal:output') {
    if (m.sessionId === app.activeId && term) term.write(String(m.data));
    return;
  }
  if (m.type === 'terminal:exit') { if (m.sessionId === app.activeId && term) { term.write('\r\n\x1b[90m[session exited]\x1b[0m\r\n'); } return; }
  if (m.type === 'error') { /* surface transient errors */ console.warn('agent error:', m.message); }
}

/**
 * The single-grant guest's arrival: open the one session they were sent to.
 * Whether this is still owed is `autoOpenSessionId`'s decision, tested there.
 */
function maybeLandInTerminal(): void {
  const opened = { landed: app.landed, activeId: app.activeId };
  const id = autoOpenSessionId(app.arrival, app.sessions.map((x) => x.id), opened);
  const session = app.sessions.find((x) => x.id === id);
  if (!session) return;
  app.landed = true;
  openTerminal(session);
}

// ---------------------------------------------------------------------------
// Session list (attention-first)
// ---------------------------------------------------------------------------
const STATE_RANK: Record<SessionState, number> = { waiting: 0, working: 1, error: 2, idle: 3, stopped: 4 };
const BADGE: Record<SessionState, { cls: string; label: string }> = {
  waiting: { cls: 'wait', label: 'Needs you' }, working: { cls: 'work', label: 'Working' },
  idle: { cls: 'idle', label: 'Idle' }, error: { cls: 'err', label: 'Error' }, stopped: { cls: 'stop', label: 'Stopped' },
};
function groupPath(groupId: string): { label: string; color: string } {
  const g = app.groups.find((x) => x.id === groupId);
  if (!g) return { label: '', color: 'var(--stop)' };
  if (g.parentId) { const p = app.groups.find((x) => x.id === g.parentId); return { label: `${p ? p.name + ' / ' : ''}${g.name}`, color: (p || g).color }; }
  return { label: g.name, color: g.color };
}

function renderSessions() {
  const ul = $('#sessions')!;
  // Sort by attention state, then name, then id. The id tiebreak matters: two
  // sessions can share a name (same name in different folders), and without a
  // total order the comparator returns 0, leaving them in whatever order the
  // agent happened to send — which used to shuffle and make them swap places.
  const sorted = [...app.sessions].sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const waiting = sorted.filter((s) => s.state === 'waiting').length;
  const attn = $('#attn')!;
  if (waiting) { attn.textContent = `${waiting} needs you`; attn.classList.remove('hidden'); } else attn.classList.add('hidden');

  if (!sorted.length) { ul.innerHTML = `<li class="empty-note"><div style="font-size:28px">✨</div><p>No sessions yet. Tap ＋ to start one.</p></li>`; return; }
  ul.innerHTML = '';
  for (const s of sorted) {
    const b = BADGE[s.state]; const gp = groupPath(s.groupId);
    const li = document.createElement('li');
    li.innerHTML = `<button class="session s-${b.cls} ${s.state === 'waiting' ? 'attn' : ''}" aria-label="${escAttr(s.name)}, ${b.label}">
      <span class="state-rail" aria-hidden="true"></span>
      <span class="s-main"><span class="s-title"><span class="s-name">${esc(s.name)}</span><span class="provider">${esc(s.shellType === 'bash' ? 'shell' : s.provider)}</span></span>
      <span class="s-sub"><span class="gd" style="background:${gp.color}"></span>${esc(gp.label)}</span></span>
      <span class="s-right"><span class="badge ${b.cls}"><span class="b-dot"></span>${b.label}</span></span>
    </button>`;
    li.firstElementChild!.addEventListener('click', () => openTerminal(s));
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Terminal (xterm)
// ---------------------------------------------------------------------------
let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let termScale = 1;
const isMobileView = () => matchMedia('(max-width:859px)').matches;

// Dynamic sizing: on mobile the phone reports its own grid to the agent
// (terminal:resize), which resizes the shared PTY so Claude REDRAWS to fit the
// phone — clean, readable, no garble. We compute the grid with FitAddon's
// proposeDimensions (measures the pane at our font size) without locally resizing
// (the size comes back authoritatively via terminal:size). Only assert on real
// changes to avoid reflow churn.
function assertMobileSize() {
  // A guest NEVER resizes the owner's PTY. Their phone must not reflow
  // somebody else's terminal — the owner would watch their session jump
  // around with no idea why. Guests read at true cell size and pan instead.
  if (isGuest()) return;
  if (!term || !fitAddon || !isMobileView() || !app.activeId) return;
  const dims = fitAddon.proposeDimensions();
  if (!dims?.cols || !dims.rows || !isFinite(dims.cols) || !isFinite(dims.rows)) return;
  // No-op if the PTY is already our size (term.cols/rows track the last
  // terminal:size). If the desktop reclaimed a bigger size, this differs and we
  // re-assert — that's how the phone takes the size back when it's active again.
  if (dims.cols === term.cols && dims.rows === term.rows) return;
  app.conn?.command({ type: 'terminal:resize', sessionId: app.activeId, cols: dims.cols, rows: dims.rows });
}

// Fallback scaler: normally the PTY matches our reported size so the terminal
// fits the pane 1:1 (scale ≈ 1). But when another viewer (the desktop) is active
// and owns a larger size, we render THAT size and scale it down so it stays clean
// (not garbled/clipped) until we reclaim the size on the next interaction.
function scaleTerm() {
  const xtermEl = term?.element;
  const screenEl = $<HTMLElement>('#screen');
  if (!xtermEl || !screenEl) return;

  // Guests are never scaled. scaleTerm() CSS-downscales rather than reflows,
  // so a 164-column desktop session shrinks to unreadable on a phone — and a
  // guest cannot fix it, because they must not resize the owner's PTY. Render
  // at true cell size and let them pan, with a banner that says why it's wide
  // rather than leaving them to conclude the page is broken.
  if (isGuest()) {
    xtermEl.style.transform = '';
    xtermEl.style.transformOrigin = '';
    termScale = 1;
    screenEl.classList.add('pan');
    updateWideBanner(screenEl);
    return;
  }

  screenEl.classList.remove('pan');
  if (!isMobileView()) { xtermEl.style.transform = ''; xtermEl.style.transformOrigin = ''; termScale = 1; return; }
  xtermEl.style.transformOrigin = 'top left';
  xtermEl.style.transform = 'none';
  const natural = xtermEl.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect().width || xtermEl.scrollWidth || 1;
  const avail = screenEl.clientWidth;
  let s = avail / natural;
  if (!isFinite(s) || s <= 0) s = 1;
  s = Math.min(1, s);
  termScale = s;
  xtermEl.style.transform = `scale(${s})`;
}
function xtermTheme() {
  const dark = isDark();
  return dark
    ? { background: '#0c0f14', foreground: '#e9edf3', cursor: '#35c2d1', selectionBackground: '#35c2d155', black: '#0c0f14', brightBlack: '#626c7b' }
    : { background: '#f5f7f9', foreground: '#131820', cursor: '#0d8794', selectionBackground: '#0d879433', black: '#f5f7f9', brightBlack: '#8b95a3' };
}
function applyTermTheme() { if (term) term.options.theme = xtermTheme(); }
function ensureTerm() {
  if (term) return;
  // xterm measures the character cell with this font on a canvas, where a CSS
  // `var(--mono)` does NOT resolve — it would silently fall back to a different
  // font and mis-measure the cell, so FitAddon then computes the wrong cols/rows
  // (garbled wrapping). Pass the resolved stack literally.
  term = new Terminal({ fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, theme: xtermTheme(), allowProposedApi: true, screenReaderMode: true });
  // This is a read-only VIEWER of the desktop's real terminal. Swallow terminal
  // query sequences (Device Attributes, cursor-position / status reports) so we
  // never echo an auto-response back into the shared PTY — the desktop is the
  // authoritative responder; a second one creates a feedback loop that the
  // state-monitor reads as activity (blip to "working" + sound + event churn).
  const swallow = () => true;
  term.parser.registerCsiHandler({ final: 'c' }, swallow); // primary Device Attributes
  term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, swallow); // secondary DA
  term.parser.registerCsiHandler({ prefix: '?', final: 'c' }, swallow);
  term.parser.registerCsiHandler({ final: 'n' }, swallow); // DSR / cursor-position report
  term.open($('#screen')!);
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon); // used only to PROPOSE a size to report; never fit() locally
  // Use the WebGL renderer: the default DOM renderer accumulates sub-pixel cell
  // drift on some mobile browsers, overlapping adjacent rows (garbled text). The
  // WebGL renderer paints every cell at exact pixel coordinates. Fall back to the
  // DOM renderer if the GL context can't be created / is lost.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch { /* no WebGL — keep the DOM renderer */ }
  term.onData((d) => app.conn?.command({ type: 'terminal:input', sessionId: app.activeId, data: d }));
  // Mobile touch scroll: xterm's own viewport doesn't reliably scroll from touch,
  // but its programmatic scroll (what wheel uses on desktop) does. Translate a
  // vertical finger drag into term.scrollLines so history is reachable.
  const screenEl = $('#screen')!;
  let lastTouchY = 0, scrollAccum = 0;
  screenEl.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) { lastTouchY = e.touches[0]!.clientY; scrollAccum = 0; }
    // Touching the terminal = the phone is the active viewer → reclaim our size
    // if the desktop had taken it (no-op when already ours).
    assertMobileSizeDebounced();
  }, { passive: true });
  screenEl.addEventListener('touchmove', (e) => {
    if (!term || e.touches.length !== 1) return;
    const y = e.touches[0]!.clientY;
    scrollAccum += y - lastTouchY;
    lastTouchY = y;
    // Cell height on screen = unscaled cell height × the visual scale.
    const cellUnscaled = Math.max(1, (screenEl.querySelector<HTMLElement>('.xterm-viewport')?.clientHeight || screenEl.clientHeight) / term.rows);
    const cell = cellUnscaled * termScale;
    const lines = Math.trunc(scrollAccum / cell);
    if (lines !== 0) {
      term.scrollLines(-lines); // drag down → reveal older lines above
      scrollAccum -= lines * cell;
      e.preventDefault(); // we handled it; don't let the page rubber-band
    }
  }, { passive: false });
  // Keep the pane pinned to the visible viewport (keyboard show/hide) and, when
  // the visible size settles, report our new grid to the agent so Claude reflows.
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', () => { syncTermPane(); scaleTerm(); assertMobileSizeDebounced(); });
    vv.addEventListener('scroll', syncTermPane);
  }
}

// Reporting our size reflows Claude on the desktop end, so debounce it — a
// keyboard animation or orientation change shouldn't fire a dozen resizes.
let assertTimer: ReturnType<typeof setTimeout> | null = null;
function assertMobileSizeDebounced() {
  if (assertTimer) clearTimeout(assertTimer);
  assertTimer = setTimeout(() => { assertTimer = null; assertMobileSize(); }, 250);
}

// Pin the terminal pane to the *visual* viewport. The layout viewport (what a
// `position: fixed; inset: 0` pane fills) is taller than the visible area on
// mobile — browser chrome and the on-screen keyboard live outside it — so the
// compose bar and the terminal's bottom rows end up below the fold with no way
// to reach them. Matching vv.height keeps everything visible; matching
// vv.offsetTop corrects the iOS keyboard, which offsets the viewport too.
function syncTermPane() {
  const vv = window.visualViewport;
  const tp = $('.term-pane');
  if (!vv || !tp || !matchMedia('(max-width:859px)').matches) return;
  tp.style.height = vv.height + 'px';
  tp.style.top = vv.offsetTop + 'px';
}

/**
 * The subtitle under the session name. A guest is told who shared this and
 * what they can do with it; the folder it lives in is the owner's context,
 * and is not disclosed to a guest anywhere else either.
 */
function termMeta(s: RSession): string {
  if (isGuest()) return esc(guestSubtitle(app.machine?.ownerName, app.machine?.role));
  const gp = groupPath(s.groupId);
  return `<span>${s.state === 'waiting' ? '● waiting for you' : esc(s.state)}</span> · ${esc(gp.label)}`;
}

function updateTermHeader() {
  if (!app.activeId) return;
  const s = app.sessions.find((x) => x.id === app.activeId);
  const meta = $('#tMeta'); const banner = $('#attnBanner');
  if (!s || !meta) return;
  meta.innerHTML = termMeta(s);
  banner?.classList.toggle('hidden', s.state !== 'waiting');
}

function openTerminal(s: RSession) {
  app.activeId = s.id;
  ensureTerm();
  term!.clear();
  $('#tName')!.textContent = s.name;
  $('#tMeta')!.innerHTML = termMeta(s);
  $('#attnBanner')!.classList.toggle('hidden', s.state !== 'waiting');
  document.body.setAttribute('data-view', 'term');
  syncTermPane();
  pushLayer(() => { document.body.removeAttribute('data-view'); if (app.activeId) { app.conn?.command({ type: 'terminal:unsubscribe', sessionId: app.activeId }); } app.activeId = null; });
  requestAnimationFrame(() => {
    syncTermPane();
    term!.focus();
    app.conn?.command({ type: 'terminal:subscribe', sessionId: s.id });
    // Report our grid so the agent reflows Claude to fit the phone. The size
    // comes back via terminal:size and drives the local xterm + scale.
    assertMobileSize();
  });
}

// accessory keys
const KEYS: Array<{ label: string; send: string; wide?: boolean }> = [
  { label: 'esc', send: '\x1b' }, { label: 'tab', send: '\t' },
  { label: '←', send: '\x1b[D' }, { label: '↑', send: '\x1b[A' }, { label: '↓', send: '\x1b[B' }, { label: '→', send: '\x1b[C' },
  { label: '⌃C', send: '\x03', wide: true }, { label: '⌃D', send: '\x04', wide: true }, { label: '⌃Z', send: '\x1a', wide: true }, { label: '⌃R', send: '\x12', wide: true },
  { label: '|', send: '|' }, { label: '~', send: '~' },
];
function buildKeys() {
  const bar = $('#keys')!;
  for (const k of KEYS) {
    const b = h('button', { class: 'key' + (k.wide ? ' wide' : ''), 'aria-label': k.label }, k.label);
    b.addEventListener('click', () => { app.conn?.command({ type: 'terminal:input', sessionId: app.activeId, data: k.send }); term?.focus(); });
    bar.appendChild(b);
  }
}
function setupCompose() {
  const ta = $<HTMLTextAreaElement>('#ta')!; const send = $<HTMLButtonElement>('#send')!;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; send.disabled = !ta.value.trim(); };
  ta.addEventListener('input', grow);
  const doSend = () => {
    const v = ta.value; const id = app.activeId;
    if (!v.trim() || !id) return;
    // Send the text, then Enter as a SEPARATE keystroke — otherwise a TUI (e.g.
    // Claude Code) treats "text\r" as a paste and inserts it instead of submitting.
    app.conn?.command({ type: 'terminal:input', sessionId: id, data: v });
    setTimeout(() => app.conn?.command({ type: 'terminal:input', sessionId: id, data: '\r' }), 25);
    ta.value = ''; grow();
  };
  send.onclick = doSend;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
}

// ---------------------------------------------------------------------------
// Fingerprint sheet
// ---------------------------------------------------------------------------
function openFp() {
  const sheet = $('#fpSheet')!;
  sheet.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="fph">
    <div class="sheet-head"><h3 id="fph">${esc(app.machine!.name)}</h3><button class="iconbtn" id="fpx" aria-label="Close">✕</button></div>
    <p>Confirm this fingerprint matches the one shown in the desktop app — it proves you're connected to this machine, not an impostor relay.</p>
    <div class="fp">${esc(app.fp || '…')}</div>
    <div class="fp-ok ${app.fpVerified ? 'good' : 'bad'}">${app.fpVerified ? '✓ identity verified' : '⚠ not verified'}</div>
    <button class="btn" id="fpd" style="margin-top:16px">Done</button></div>`;
  sheet.classList.add('open'); pushLayer(() => sheet.classList.remove('open'));
  sheet.onclick = (e) => { if (e.target === sheet) history.back(); };
  $('#fpx')!.onclick = () => history.back(); $('#fpd')!.onclick = () => history.back();
}

// ---------------------------------------------------------------------------
// Create session (existing group)
// ---------------------------------------------------------------------------
let selGroupId = ''; let selProvider = 'claude'; let pendingGroupName = '';
let onDirs: ((d: { path: string; entries: string[] }) => void) | null = null;
const PROVIDERS = ['claude', 'codex', 'grok', 'opencode', 'kimi', 'cursor', 'antigravity', 'shell'];
const GROUP_COLORS = ['#35c2d1', '#f2b23d', '#48c98b', '#c98be0', '#58a6ff', '#f0625d'];

function openCreate() {
  const sheet = $('#createSheet')!;
  sheet.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="crh">
    <div class="sheet-head"><h3 id="crh">New session</h3><button class="iconbtn" id="crx" aria-label="Close">✕</button></div>
    <div class="fld-label">Group</div>
    <ul class="grouptree" id="gtree" role="listbox" aria-label="Choose a group"></ul>
    <button class="newgroup" id="newGroupBtn">＋ New group…</button>
    <div class="fld-label">Agent</div>
    <div class="provider-row" id="prov">${PROVIDERS.map((p) => `<button class="pchip" data-p="${p}" aria-pressed="${p === 'claude'}">${p === 'shell' ? 'Shell' : p[0]!.toUpperCase() + p.slice(1)}</button>`).join('')}</div>
    <div class="fld-label">Name <span style="text-transform:none;color:var(--faint)">(optional)</span></div>
    <input class="txt" id="sname" placeholder="session" autocapitalize="off" spellcheck="false" />
    <button class="btn" id="crGo" style="margin-top:18px">Start session</button>
  </div>`;
  sheet.classList.add('open'); pushLayer(() => sheet.classList.remove('open'));
  sheet.onclick = (e) => { if (e.target === sheet) history.back(); };
  $('#crx')!.onclick = () => history.back();
  selGroupId = ''; buildCreateTree();
  selProvider = 'claude';
  $('#prov')!.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('.pchip'); if (!b) { return; } selProvider = b.getAttribute('data-p')!; $('#prov')!.querySelectorAll('.pchip').forEach((x) => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); });
  $('#newGroupBtn')!.onclick = openNewGroup;
  $('#crGo')!.onclick = () => {
    if (!selGroupId) return;
    const name = ($<HTMLInputElement>('#sname')!.value || '').trim();
    app.conn?.command({ type: 'session:create', groupId: selGroupId, name: name || undefined, provider: selProvider });
    history.back();
  };
}

function buildCreateTree() {
  const tree = $('#gtree'); if (!tree) return;
  tree.innerHTML = '';
  for (const g of app.groups.filter((x) => !x.parentId)) {
    addGroupRow(tree, g, false);
    for (const sub of app.groups.filter((x) => x.parentId === g.id)) addGroupRow(tree, sub, true, g);
  }
  const rows = [...tree.querySelectorAll<HTMLElement>('.gitem')];
  let pick: HTMLElement | null = null;
  if (pendingGroupName) { pick = rows.find((r) => app.groups.find((g) => g.id === r.dataset.gid)?.name === pendingGroupName) || null; pendingGroupName = ''; }
  if (!pick && selGroupId) pick = rows.find((r) => r.dataset.gid === selGroupId) || null;
  pick ??= rows[0] ?? null;
  if (pick) selectGroup(pick, pick.dataset.gid!); else { selGroupId = ''; const go = $<HTMLButtonElement>('#crGo'); if (go) go.disabled = true; }
}
function addGroupRow(tree: HTMLElement, g: RGroup, isSub: boolean, parent?: RGroup) {
  const color = (parent || g).color;
  const b = h('button', { class: 'gitem' + (isSub ? ' sub' : ''), role: 'option', 'aria-selected': 'false' },
    `<span class="g-dot" style="background:${color}"></span><span class="g-name ${isSub ? 'subname' : ''}">${esc(g.name)}</span><span class="g-dir">${esc(g.workingDir || '~')}</span><span class="g-check">✓</span>`);
  b.dataset.gid = g.id;
  b.addEventListener('click', () => selectGroup(b, g.id));
  const li = document.createElement('li'); li.appendChild(b); tree.appendChild(li);
}
function selectGroup(el: HTMLElement, id: string) { selGroupId = id; el.closest('.grouptree')!.querySelectorAll('.gitem').forEach((x) => x.setAttribute('aria-selected', 'false')); el.setAttribute('aria-selected', 'true'); const go = $<HTMLButtonElement>('#crGo'); if (go) go.disabled = false; }

// --- new group ---
let ngParent = '__top'; let ngPath = '~'; let ngColor = GROUP_COLORS[0];
function openNewGroup() {
  const sel = app.groups.find((x) => x.id === selGroupId);
  ngParent = sel ? (sel.parentId ?? sel.id) : '__top';
  ngColor = GROUP_COLORS[0];
  const tops = app.groups.filter((g) => !g.parentId);
  const sheet = $('#newGroupSheet')!;
  sheet.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ngh">
    <div class="sheet-head"><h3 id="ngh">New group</h3><button class="iconbtn" id="ngx" aria-label="Close">✕</button></div>
    <div class="fld-label">Add to</div>
    <div class="provider-row" id="ngPlace">
      ${tops.map((g) => `<button class="pchip" data-parent="${g.id}" aria-pressed="${g.id === ngParent}"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${g.color};margin-right:6px;vertical-align:middle"></span>${esc(g.name)}</button>`).join('')}
      <button class="pchip" data-parent="__top" aria-pressed="${ngParent === '__top'}">＋ New top-level</button>
    </div>
    <div class="fld-label">Name</div>
    <input class="txt" id="ngName" placeholder="e.g. AI Engine" autocapitalize="off" spellcheck="false" />
    <div class="fld-label">Working folder</div>
    <div class="dirbrowser"><div class="crumbs" id="ngCrumbs"></div><ul class="dirlist" id="ngList"></ul></div>
    <div id="ngColorField"><div class="fld-label">Color <span style="text-transform:none;color:var(--faint)">(top-level only)</span></div><div class="swatches" id="ngSw"></div></div>
    <button class="btn" id="ngGo" style="margin-top:18px">Create group</button>
  </div>`;
  sheet.classList.add('open'); pushLayer(() => { sheet.classList.remove('open'); onDirs = null; });
  sheet.onclick = (e) => { if (e.target === sheet) history.back(); };
  $('#ngx')!.onclick = () => history.back();
  const colorField = $('#ngColorField')!;
  const syncColor = () => { colorField.style.display = ngParent === '__top' ? 'block' : 'none'; };
  $('#ngPlace')!.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('.pchip'); if (!b) { return; } ngParent = b.getAttribute('data-parent')!; $('#ngPlace')!.querySelectorAll('.pchip').forEach((x) => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); syncColor(); });
  const sw = $('#ngSw')!;
  GROUP_COLORS.forEach((c, i) => { const b = h('button', { class: 'sw', 'aria-pressed': String(i === 0), 'aria-label': 'color' }); b.style.background = c; b.onclick = () => { ngColor = c; sw.querySelectorAll('.sw').forEach((x) => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); }; sw.appendChild(b); });
  syncColor();
  onDirs = renderDirs;
  const parentDir = sel?.parentId ? app.groups.find((g) => g.id === sel.parentId)?.workingDir : sel?.workingDir;
  browseDir(parentDir || '~');
  $('#ngGo')!.onclick = () => {
    const name = ($<HTMLInputElement>('#ngName')!.value || '').trim() || 'Group';
    pendingGroupName = name;
    app.conn?.command({ type: 'group:create', name, parentId: ngParent === '__top' ? null : ngParent, workingDir: ngPath, color: ngColor });
    history.back(); // groups refresh will rebuild the tree and select the new group
  };
}
function browseDir(p: string) { ngPath = p; app.conn?.command({ type: 'dirs:list', path: p }); }
function renderDirs(d: { path: string; entries: string[] }) {
  ngPath = d.path;
  const crumbs = $('#ngCrumbs'); const list = $('#ngList'); if (!crumbs || !list) return;
  crumbs.innerHTML = '';
  const parts = d.path === '/' ? [''] : d.path.replace(/\/$/, '').split('/');
  let acc = '';
  parts.forEach((seg, i) => {
    const base = acc === '/' ? '' : acc;
    acc = i === 0 ? (seg || '/') : base + '/' + seg;
    const p = acc;
    const b = h('button', { class: 'crumb' + (i === parts.length - 1 ? ' last' : '') }, esc(seg || '/'));
    b.onclick = () => browseDir(p);
    crumbs.appendChild(b);
    if (i < parts.length - 1) crumbs.appendChild(h('span', { class: 'crumb-sep' }, ' / '));
  });
  crumbs.appendChild(h('span', { class: 'grow' }));
  const edit = h('button', { class: 'crumb-edit', 'aria-label': 'Type a path' }, '✎ path'); crumbs.appendChild(edit);
  const inp = document.createElement('input'); inp.className = 'path-input'; inp.value = d.path; inp.placeholder = '~/code/newproject'; inp.setAttribute('spellcheck', 'false'); crumbs.appendChild(inp);
  edit.onclick = () => { crumbs.classList.add('editing'); inp.focus(); inp.select(); };
  inp.onkeydown = (e) => { if (e.key === 'Enter') { crumbs.classList.remove('editing'); if (inp.value.trim()) browseDir(inp.value.trim()); } else if (e.key === 'Escape') crumbs.classList.remove('editing'); };
  inp.onblur = () => crumbs.classList.remove('editing');
  list.innerHTML = '';
  if (!d.entries.length) list.appendChild(h('li', {}, '<div class="dir empty">No subfolders — use this folder</div>'));
  for (const name of d.entries) { const b = h('button', { class: 'dir' }, `<span class="f-ico">📁</span><span class="f-name">${esc(name)}</span><span class="f-chev">›</span>`); b.onclick = () => browseDir(d.path.replace(/\/$/, '') + '/' + name); const li = document.createElement('li'); li.appendChild(b); list.appendChild(li); }
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/** Avatars come from GitHub via our own DB, but src is attacker-adjacent
 *  enough to be worth a scheme check rather than a trusting interpolation. */
const safeAvatar = (url: string | null | undefined) => (url?.startsWith('https://') ? url : null);

const initialOf = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?';

/**
 * A signed-in line for screens that have no header bar to hang the avatar on.
 * Only the empty state needs it today, but that is the screen a wrong-account
 * sign-in lands on, so it is not an optional flourish there.
 */
function accountFooter(): string {
  const name = app.user?.githubLogin ? `@${app.user.githubLogin}` : app.user?.displayName;
  if (!name) return '';
  return `<p class="acct-foot">Signed in as ${esc(name)} · <button id="emptyOut">Sign out</button></p>`;
}

function accountButton(): string {
  const u = app.user;
  const name = u?.displayName ?? 'your account';
  const avatar = safeAvatar(u?.avatarUrl);
  const face = avatar
    ? `<img class="avatar" src="${escAttr(avatar)}" alt="" />`
    : `<span class="avatar init">${esc(initialOf(name))}</span>`;
  return `<button class="acctbtn" id="acct" aria-label="Account — signed in as ${escAttr(name)}">${face}</button>`;
}

function openAccount() {
  const u = app.user;
  const name = u?.displayName ?? 'Signed in';
  const avatar = safeAvatar(u?.avatarUrl);
  // The handle is the point of this sheet, not decoration: an addressed invite
  // matches on it, and until now nothing in the UI revealed what we hold.
  const handle = u?.githubLogin
    ? `<div class="acct-handle">@${esc(u.githubLogin)}</div>`
    : `<div class="banner warn" role="status">We don't have your GitHub handle on file. Invites addressed to a
       specific account can't reach you until you sign in again — that fetches it.</div>`;

  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim open';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="acch">
    <div class="sheet-head"><h3 id="acch">Account</h3><button class="iconbtn" id="accx" aria-label="Close">✕</button></div>
    <div class="acct-id">
      ${avatar ? `<img class="avatar lg" src="${escAttr(avatar)}" alt="" />` : `<span class="avatar init lg">${esc(initialOf(name))}</span>`}
      <div class="acct-who">
        <div class="acct-name">${esc(name)}</div>
        ${u?.email ? `<div class="acct-mail">${esc(u.email)}</div>` : ''}
      </div>
    </div>
    ${handle}
    <button class="btn ghost" id="accLink" style="margin-top:18px">Link a machine</button>
    <button class="btn ghost" id="accOut" style="margin-top:10px">Sign out</button>
  </div>`;
  document.body.appendChild(scrim);
  pushLayer(() => scrim.remove());
  scrim.onclick = (e) => { if (e.target === scrim) history.back(); };
  $('#accx')!.onclick = () => history.back();
  // The pill's menu is the other way in, and a single-grant guest has no pill.
  // Someone who owns a machine and was then invited to a session must not lose
  // the ability to link their own — this sheet is reachable from every screen.
  $('#accLink')!.onclick = () => openLinkMachine();
  $('#accOut')!.onclick = (e) => void signOut({ btn: e.currentTarget as HTMLButtonElement });
}

/**
 * End the session on the server, then reload signed-out.
 *
 * Local state is cleared because it is per-ACCOUNT, not per-browser: leaving a
 * machine preference or a half-finished invite behind would greet whoever signs
 * in next with the last person's context. The reload (rather than a re-render)
 * is deliberate — it drops the decrypted terminal buffers held in memory.
 */
async function signOut(opts: { to?: string; stashInvite?: string; btn?: HTMLButtonElement | null } = {}): Promise<void> {
  const { to = '/', stashInvite, btn } = opts;
  if (btn) { btn.disabled = true; btn.textContent = 'Signing out…'; }
  app.conn?.close();
  try {
    // Bounded, because the alternative to a slow relay answering is not
    // "wait longer" — it is a disabled button that never comes back. The
    // cookie may then outlive the click, so we cannot claim success; the
    // local wipe and the reload still land them on the sign-in screen,
    // which is where a retry starts from anyway.
    await Promise.race([
      api('/auth/logout', { method: 'POST' }),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch {
    // Same reasoning: a network failure changes nothing about where we go.
  }
  clearAccountState({ local: localStorage, session: sessionStorage }, stashInvite);
  location.href = to;
}

// ---------------------------------------------------------------------------
// Sharing: the owner's list of who can reach this machine, and the guest's
// mirror of what is shared with them
// ---------------------------------------------------------------------------

function openSharing(): void {
  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim open';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="shh">
    <div class="sheet-head"><h3 id="shh">Sharing</h3><button class="iconbtn" id="shx" aria-label="Close">✕</button></div>
    <p>Who can reach <b>${esc(app.machine!.name)}</b> right now, and who has been invited.</p>
    <div class="banner hidden" id="shNote" role="status"></div>
    <ul class="share-list" id="shList"><li class="empty-note"><div class="spinner"></div></li></ul>
  </div>`;
  document.body.appendChild(scrim);
  pushLayer(() => scrim.remove());
  scrim.onclick = (e) => { if (e.target === scrim) history.back(); };
  $('#shx')!.onclick = () => history.back();
  void loadOwnerShares();
}

async function loadOwnerShares(): Promise<void> {
  let rows: ShareRow[];
  try {
    const res = await api(`/api/machines/${app.machine!.id}/shares`);
    if (!res.ok) throw new Error();
    const body = (await res.json()) as { invites: WireShareInvite[]; grants: WireShareGrant[] };
    rows = ownerShareRows(body.invites, body.grants, Date.now());
  } catch {
    return renderShareLoadError('#shList', loadOwnerShares);
  }
  renderShareRows(
    '#shList',
    rows,
    `<div style="font-size:28px">🤝</div><p>Nothing is shared right now. Share a session from the desktop app to invite someone.</p>`,
    (r, b) => void revokeOwnerRow(r, b),
  );
}

async function revokeOwnerRow(row: ShareRow, btn: HTMLButtonElement): Promise<void> {
  if (!confirm(confirmCopy(row))) return;
  btn.disabled = true;
  // Invites are cancelled on the machine-scoped route; grants on their own.
  const path = row.kind === 'invite'
    ? `/api/machines/${app.machine!.id}/shares/${row.id}`
    : `/api/shares/${row.id}`;
  const status = await del(path);
  const note = $('#shNote');
  if (status === 204 || status === 404) {
    if (note) {
      note.className = `banner ${status === 204 ? 'ok' : 'warn'}`;
      note.textContent = status === 204 ? revokeDoneCopy(row, machineOffline) : revokeFailedCopy(404);
    }
    void loadOwnerShares();
    return;
  }
  if (note) { note.className = 'banner err'; note.textContent = revokeFailedCopy(status); }
  btn.disabled = false;
}

function openMyShares(): void {
  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim open';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="msh">
    <div class="sheet-head"><h3 id="msh">Your access</h3><button class="iconbtn" id="msx" aria-label="Close">✕</button></div>
    <p>What people are sharing with you. Leaving hands access back — nobody has to approve it.</p>
    <div class="banner hidden" id="msNote" role="status"></div>
    <ul class="share-list" id="msList"><li class="empty-note"><div class="spinner"></div></li></ul>
  </div>`;
  document.body.appendChild(scrim);
  pushLayer(() => scrim.remove());
  scrim.onclick = (e) => { if (e.target === scrim) history.back(); };
  $('#msx')!.onclick = () => history.back();
  void loadMyShares();
}

async function loadMyShares(): Promise<void> {
  let rows: ShareRow[];
  try {
    const res = await api('/api/shares');
    if (!res.ok) throw new Error();
    const body = (await res.json()) as { grants: WireMyShare[] };
    rows = guestShareRows(body.grants, Date.now());
  } catch {
    return renderShareLoadError('#msList', loadMyShares);
  }
  renderShareRows(
    '#msList',
    rows,
    `<div style="font-size:28px">🤝</div><p>Nothing is shared with you right now. If someone sends you a link, it starts here.</p>`,
    (r, b) => void leaveShareRow(r, b),
  );
}

async function leaveShareRow(row: ShareRow, btn: HTMLButtonElement): Promise<void> {
  if (!confirm(confirmCopy(row))) return;
  btn.disabled = true;
  // Leaving the share we are connected THROUGH: tear the channel down first,
  // deliberately, so the relay cutting it doesn't render as "your access was
  // ended" — a false story about a choice this person just made.
  const current = app.machine?.grantId === row.id;
  if (current) { stopPolling(); reconnector.cancel(); app.conn?.close(); app.conn = null; }
  const status = await del(`/api/shares/${row.id}`);
  if (status === 204 || status === 404) {
    if (current) { localStorage.removeItem('bodhi.machineId'); location.href = '/'; return; }
    const note = $('#msNote');
    if (note) { note.className = 'banner ok'; note.textContent = revokeDoneCopy(row, false); }
    void loadMyShares();
    return;
  }
  const note = $('#msNote');
  if (note) { note.className = 'banner err'; note.textContent = revokeFailedCopy(status); }
  if (current) connect();
  btn.disabled = false;
}

function renderShareRows(
  listSel: string,
  rows: ShareRow[],
  emptyHtml: string,
  act: (row: ShareRow, btn: HTMLButtonElement) => void,
): void {
  const list = $(listSel);
  if (!list) return; // the sheet was closed while the fetch was in flight
  if (!rows.length) { list.innerHTML = `<li class="empty-note">${emptyHtml}</li>`; return; }
  list.innerHTML = '';
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = 'share-row';
    const actionLabel = `${r.action} — ${r.person}`;
    li.innerHTML = `<div class="share-main">
      <div class="share-who">${esc(r.person)}</div>
      <div class="share-meta"><span class="share-role">${esc(r.roleWord)}</span>${r.pending ? '<span class="share-pend">Pending</span>' : ''}</div>
      <div class="share-detail">${esc(r.detail)}</div></div>
      <button class="share-x" aria-label="${escAttr(actionLabel)}">${esc(r.action)}</button>`;
    const btn = li.querySelector<HTMLButtonElement>('button')!;
    btn.onclick = () => act(r, btn);
    list.appendChild(li);
  }
}

function renderShareLoadError(listSel: string, retry: () => Promise<void>): void {
  const list = $(listSel);
  if (!list) return;
  list.innerHTML = `<li class="empty-note"><div style="font-size:28px">📡</div>
    <p>Couldn't load this. Check your connection.</p>
    <button class="btn ghost" style="margin-top:6px">Try again</button></li>`;
  list.querySelector('button')!.addEventListener('click', () => {
    list.innerHTML = `<li class="empty-note"><div class="spinner"></div></li>`;
    void retry();
  });
}

/** DELETE, returning the status — null when the request never got through. */
async function del(path: string): Promise<number | null> {
  try {
    return (await api(path, { method: 'DELETE' })).status;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Machine switching + linking
// ---------------------------------------------------------------------------
function openMachineMenu() {
  const title = machineMenuTitle(app.machines);
  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim open';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mmh">
    <div class="sheet-head"><h3 id="mmh">${esc(title)}</h3><button class="iconbtn" id="mmx" aria-label="Close">✕</button></div>
    <ul class="grouptree" id="mmList" role="listbox" aria-label="${escAttr(title)}"></ul>
    <button class="newgroup" id="mmLink">＋ Link another machine</button>
  </div>`;
  document.body.appendChild(scrim);
  pushLayer(() => scrim.remove());
  scrim.onclick = (e) => { if (e.target === scrim) history.back(); };
  $('#mmx')!.onclick = () => history.back();
  const list = $('#mmList')!;
  // Sectioned, and shared rows labelled by the person who shared them:
  // "SHARED WITH ME" over "Will's laptop". A guest reads the list as people.
  const sections = machineSections(app.machines);
  const titled = showSectionTitles(sections);
  for (const section of sections) {
    if (titled) {
      const head = document.createElement('li');
      head.className = 'gsection';
      head.setAttribute('role', 'presentation');
      head.textContent = section.title;
      list.appendChild(head);
    }
    for (const m of section.items) {
      const sel = m.id === app.machine?.id;
      const b = h('button', { class: 'gitem machine', role: 'option', 'aria-selected': String(sel) },
        `<span class="g-dot" style="background:${sel ? 'var(--idle)' : 'var(--stop)'}"></span><span class="g-name">${esc(machineLabel(m))}</span><span class="g-check">✓</span>`);
      b.onclick = () => {
        if (sel) { history.back(); return; }
        localStorage.setItem('bodhi.machineId', m.id);
        location.reload();
      };
      const li = document.createElement('li'); li.appendChild(b); list.appendChild(li);
    }
  }
  // Stack the link sheet on top of the menu (like the create → new-group
  // flow). Do NOT history.back() first: popstate is async and would fire
  // after openLinkMachine() pushed its layer, tearing the link sheet down.
  $('#mmLink')!.onclick = () => openLinkMachine();
}

function openLinkMachine() {
  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim open';
  scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="lkh">
    <div class="sheet-head"><h3 id="lkh">Link a machine</h3><button class="iconbtn" id="lkx" aria-label="Close">✕</button></div>
    <p>In the desktop app open <b>Settings → Remote Hosting → Generate link code</b>, then enter the code here.</p>
    <div class="fld-label">Link code</div>
    <input class="txt" id="lkCode" placeholder="XXXX-XXXX" autocapitalize="characters" autocomplete="off" spellcheck="false" />
    <div class="banner err hidden" id="lkErr" role="alert"></div>
    <button class="btn" id="lkGo" style="margin-top:16px">Link machine</button>
  </div>`;
  document.body.appendChild(scrim);
  pushLayer(() => scrim.remove());
  scrim.onclick = (e) => { if (e.target === scrim) history.back(); };
  $('#lkx')!.onclick = () => history.back();
  const codeInput = $<HTMLInputElement>('#lkCode')!;
  const err = $('#lkErr')!;
  const go = $<HTMLButtonElement>('#lkGo')!;
  setTimeout(() => codeInput.focus(), 50);
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase(); });
  const submit = async () => {
    const code = codeInput.value.trim();
    if (!code) return;
    go.disabled = true; err.classList.add('hidden');
    try {
      const res = await api('/link/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      if (res.ok) {
        const { machine } = (await res.json()) as { machine: Machine };
        localStorage.setItem('bodhi.machineId', machine.id);
        location.reload();
        return;
      }
      const data = (await res.json().catch(() => ({ error: 'link_failed' }))) as { error?: string };
      err.textContent = linkErrorText(data.error);
      err.classList.remove('hidden');
      go.disabled = false;
    } catch {
      err.textContent = "Couldn't reach the relay. Check your connection and try again.";
      err.classList.remove('hidden');
      go.disabled = false;
    }
  };
  go.onclick = submit;
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}

function linkErrorText(error?: string): string {
  switch (error) {
    case 'link_not_found': return "That code wasn't found — double-check it and try again.";
    case 'link_expired': return 'That code expired. Generate a fresh one in the desktop app.';
    case 'link_already_used': return 'That code was already used. Generate a new one.';
    case 'invalid_request': return 'Enter a valid link code.';
    default: return "Couldn't link that code. Please try again.";
  }
}

// Root scope, so the worker covers `/i/*` invite links and can carry web
// push. An updated worker must never take over a page mid-terminal-session;
// sw.js therefore never calls skipWaiting/clients.claim, and nothing here
// needs to wait on, prompt about, or reload for an update.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

boot();
