import './styles.css';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { RelayConnection, type ConnState, type Inner } from './connection';

// ---------------------------------------------------------------------------
// Types (mirror the agent's sealed payloads)
// ---------------------------------------------------------------------------
type SessionState = 'idle' | 'working' | 'waiting' | 'error' | 'stopped';
interface RSession { id: string; name: string; state: SessionState; groupId: string; workingDir: string; provider: string; shellType: string; }
interface RGroup { id: string; name: string; color: string; workingDir: string; parentId: string | null; }
interface Machine { id: string; name: string; ed25519Pub: string; lastSeenAt: number | null; }

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
const app = { conn: null as RelayConnection | null, machine: null as Machine | null, sessions: [] as RSession[], groups: [] as RGroup[], activeId: null as string | null, fp: '', fpVerified: false, devLogin: false };
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
    const me = await api('/api/me');
    if (!me.ok) return renderSignIn();
    const { machines } = await api('/api/machines').then((r) => r.json());
    renderApp(machines as Machine[]);
  } catch {
    renderSignIn();
  }
}

function renderSignIn() {
  rootEl.innerHTML = `
    <div class="screen-center"><div class="card-center">
      <div class="logo">🛰️</div>
      <h1>Bodhilander Remote</h1>
      <p>Reach your desktop's sessions from anywhere — end-to-end encrypted.</p>
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
  if (!machines.length) {
    rootEl.innerHTML = `<div class="screen-center"><div class="card-center">
      <div class="logo">🖥️</div><h1>No machines linked</h1>
      <p>In the desktop app, open <b>Settings → Remote Hosting → Generate link code</b>, then link it here.</p>
      <button class="btn ghost" onclick="location.reload()">Refresh</button>
    </div></div>`;
    return;
  }
  app.machine = machines[0]!; // TODO: machine switcher when >1

  rootEl.innerHTML = `
  <div class="app">
    <section class="pane list-pane" aria-label="Sessions">
      <header class="bar">
        <div class="brand grow"><span class="logo">🛰️</span> <span>Bodhilander</span></div>
        <button class="iconbtn" id="theme" aria-label="Toggle light/dark theme">◐</button>
      </header>
      <div style="padding:12px 16px 0"><button class="machine-pill" id="machineBtn"><span class="dot off" id="mdot"></span> <span>${esc(app.machine.name)}</span></button></div>
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
  </div>`;

  $('#theme')!.onclick = toggleTheme;
  $('#fab')!.onclick = openCreate;
  $('#fpBtn')!.onclick = openFp; $('#fpBtn2')!.onclick = openFp;
  $('#back')!.onclick = () => history.back();
  buildKeys();
  setupCompose();
  connect();
}

// ---------------------------------------------------------------------------
// Connection + presence
// ---------------------------------------------------------------------------
function connect() {
  const conn = new RelayConnection(app.machine!.id, app.machine!.ed25519Pub);
  app.conn = conn;
  conn.onFingerprint = (fp, ok) => { app.fp = fp; app.fpVerified = ok; };
  conn.onState = (s: ConnState, detail?: string) => onConnState(s, detail);
  conn.onMessage = (m) => onAgentMessage(m);
  conn.connect();
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastSessionsJson = '';
function startPolling() { stopPolling(); pollTimer = setInterval(() => app.conn?.command({ type: 'sessions:list' }), 2500); }
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function onConnState(s: ConnState, detail?: string) {
  const dot = $('#mdot'); const list = $('#sessions');
  if (s === 'ready') {
    dot?.classList.remove('off');
    app.conn!.command({ type: 'groups:list' });
    app.conn!.command({ type: 'sessions:list' });
    startPolling(); // keep the list live (new/removed sessions + state changes)
  } else if (s === 'offline') {
    stopPolling(); dot?.classList.add('off');
    if (list) list.innerHTML = `<li class="empty-note"><div style="font-size:28px">🌙</div><p>This machine is offline. It'll appear here when it reconnects.</p></li>`;
  } else if (s === 'error') {
    stopPolling(); dot?.classList.add('off');
    if (list) list.innerHTML = `<li class="empty-note"><div style="font-size:28px">⚠️</div><p>${esc(detail || 'Connection problem.')}</p></li>`;
  } else if (s === 'closed') {
    stopPolling(); dot?.classList.add('off');
    setTimeout(() => { if (app.conn) connect(); }, 3000); // simple reconnect
  }
}

function onAgentMessage(m: Inner) {
  if (m.type === 'groups') { app.groups = (m.groups as RGroup[]) || []; renderSessions(); return; }
  if (m.type === 'sessions') {
    const list = (m.sessions as RSession[]) || [];
    const j = JSON.stringify(list);
    if (j === lastSessionsJson) return; // unchanged — skip re-render (avoid flicker)
    lastSessionsJson = j;
    app.sessions = list;
    renderSessions();
    updateTermHeader(); // keep the open terminal's state chip / attention banner live
    return;
  }
  if (m.type === 'terminal:size') { if (m.sessionId === app.activeId && term) term.resize(Math.max(2, Number(m.cols) || 80), Math.max(2, Number(m.rows) || 24)); return; }
  if (m.type === 'terminal:output') { if (m.sessionId === app.activeId && term) term.write(String(m.data)); return; }
  if (m.type === 'terminal:exit') { if (m.sessionId === app.activeId && term) term.write('\r\n\x1b[90m[session exited]\x1b[0m\r\n'); return; }
  if (m.type === 'error') { /* surface transient errors */ console.warn('agent error:', m.message); }
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
  const sorted = [...app.sessions].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.name.localeCompare(b.name));
  const waiting = sorted.filter((s) => s.state === 'waiting').length;
  const attn = $('#attn')!;
  if (waiting) { attn.textContent = `${waiting} needs you`; attn.classList.remove('hidden'); } else attn.classList.add('hidden');

  if (!sorted.length) { ul.innerHTML = `<li class="empty-note"><div style="font-size:28px">✨</div><p>No sessions yet. Tap ＋ to start one.</p></li>`; return; }
  ul.innerHTML = '';
  for (const s of sorted) {
    const b = BADGE[s.state]; const gp = groupPath(s.groupId);
    const li = document.createElement('li');
    li.innerHTML = `<button class="session s-${s.state === 'working' ? 'work' : s.state === 'waiting' ? 'wait' : s.state === 'error' ? 'err' : s.state === 'idle' ? 'idle' : 'stop'} ${s.state === 'waiting' ? 'attn' : ''}" aria-label="${esc(s.name)}, ${b.label}">
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
function xtermTheme() {
  const dark = isDark();
  return dark
    ? { background: '#0c0f14', foreground: '#e9edf3', cursor: '#35c2d1', selectionBackground: '#35c2d155', black: '#0c0f14', brightBlack: '#626c7b' }
    : { background: '#f5f7f9', foreground: '#131820', cursor: '#0d8794', selectionBackground: '#0d879433', black: '#f5f7f9', brightBlack: '#8b95a3' };
}
function applyTermTheme() { if (term) term.options.theme = xtermTheme(); }
function ensureTerm() {
  if (term) return;
  term = new Terminal({ fontFamily: 'var(--mono)', fontSize: 13, cursorBlink: true, scrollback: 5000, theme: xtermTheme(), allowProposedApi: true, screenReaderMode: true });
  term.open($('#screen')!);
  term.onData((d) => app.conn?.command({ type: 'terminal:input', sessionId: app.activeId, data: d }));
  // The terminal matches the desktop's size (via terminal:size), so we don't
  // fit/resize the PTY. We only keep the pane sized to the visible viewport so
  // the on-screen keyboard doesn't hide it (and can't be over-scrolled past).
  const vv = window.visualViewport;
  if (vv) vv.addEventListener('resize', () => { const tp = $('.term-pane'); if (tp && matchMedia('(max-width:859px)').matches) tp.style.height = vv.height + 'px'; });
}

function updateTermHeader() {
  if (!app.activeId) return;
  const s = app.sessions.find((x) => x.id === app.activeId);
  const meta = $('#tMeta'); const banner = $('#attnBanner');
  if (!s || !meta) return;
  const gp = groupPath(s.groupId);
  meta.innerHTML = `<span>${s.state === 'waiting' ? '● waiting for you' : esc(s.state)}</span> · ${esc(gp.label)}`;
  banner?.classList.toggle('hidden', s.state !== 'waiting');
}

function openTerminal(s: RSession) {
  app.activeId = s.id;
  ensureTerm();
  term!.clear();
  $('#tName')!.textContent = s.name;
  const gp = groupPath(s.groupId);
  $('#tMeta')!.innerHTML = `<span class="${s.state === 'waiting' ? '' : ''}">${s.state === 'waiting' ? '● waiting for you' : s.state}</span> · ${esc(gp.label)}`;
  $('#attnBanner')!.classList.toggle('hidden', s.state !== 'waiting');
  document.body.setAttribute('data-view', 'term');
  pushLayer(() => { document.body.removeAttribute('data-view'); if (app.activeId) app.conn?.command({ type: 'terminal:unsubscribe', sessionId: app.activeId }); app.activeId = null; });
  requestAnimationFrame(() => { term!.focus(); });
  app.conn?.command({ type: 'terminal:subscribe', sessionId: s.id });
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
let selGroupId = ''; let selProvider = 'claude';
const PROVIDERS = ['claude', 'codex', 'grok', 'opencode', 'kimi', 'cursor', 'antigravity', 'shell'];
function openCreate() {
  const sheet = $('#createSheet')!;
  const tops = app.groups.filter((g) => !g.parentId);
  sheet.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="crh">
    <div class="sheet-head"><h3 id="crh">New session</h3><button class="iconbtn" id="crx" aria-label="Close">✕</button></div>
    <div class="fld-label">Group</div>
    <ul class="grouptree" id="gtree" role="listbox" aria-label="Choose a group"></ul>
    <div class="fld-label">Agent</div>
    <div class="provider-row" id="prov">${PROVIDERS.map((p) => `<button class="pchip" data-p="${p}" aria-pressed="${p === 'claude'}">${p === 'shell' ? 'Shell' : p[0]!.toUpperCase() + p.slice(1)}</button>`).join('')}</div>
    <div class="fld-label">Name <span style="text-transform:none;color:var(--faint)">(optional)</span></div>
    <input class="txt" id="sname" placeholder="session" autocapitalize="off" spellcheck="false" />
    <button class="btn" id="crGo" style="margin-top:18px" ${tops.length ? '' : 'disabled'}>Start session</button>
    ${tops.length ? '' : '<div class="banner err">No groups on this machine yet — create one in the desktop app first.</div>'}
  </div>`;
  sheet.classList.add('open'); pushLayer(() => sheet.classList.remove('open'));
  sheet.onclick = (e) => { if (e.target === sheet) history.back(); };
  $('#crx')!.onclick = () => history.back();

  // group tree
  const tree = $('#gtree')!; selGroupId = '';
  for (const g of tops) {
    addGroupRow(tree, g, false); if (!selGroupId) selectGroup(tree.lastElementChild!.firstElementChild as HTMLElement, g.id);
    for (const sub of app.groups.filter((x) => x.parentId === g.id)) addGroupRow(tree, sub, true, g);
  }
  selProvider = 'claude';
  $('#prov')!.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('.pchip'); if (!b) return; selProvider = b.getAttribute('data-p')!; $('#prov')!.querySelectorAll('.pchip').forEach((x) => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); });
  $('#crGo')!.onclick = () => {
    if (!selGroupId) return;
    const name = ($<HTMLInputElement>('#sname')!.value || '').trim();
    app.conn?.command({ type: 'session:create', groupId: selGroupId, name: name || undefined, provider: selProvider });
    history.back();
  };
}
function addGroupRow(tree: HTMLElement, g: RGroup, isSub: boolean, parent?: RGroup) {
  const color = (parent || g).color;
  const b = h('button', { class: 'gitem' + (isSub ? ' sub' : ''), role: 'option', 'aria-selected': 'false' },
    `<span class="g-dot" style="background:${color}"></span><span class="g-name ${isSub ? 'subname' : ''}">${esc(g.name)}</span><span class="g-dir">${esc(g.workingDir || '~')}</span><span class="g-check">✓</span>`);
  b.addEventListener('click', () => selectGroup(b, g.id));
  const li = document.createElement('li'); li.appendChild(b); tree.appendChild(li);
}
function selectGroup(el: HTMLElement, id: string) { selGroupId = id; el.closest('.grouptree')!.querySelectorAll('.gitem').forEach((x) => x.setAttribute('aria-selected', 'false')); el.setAttribute('aria-selected', 'true'); }

boot();
