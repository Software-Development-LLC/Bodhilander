import type { RelayConfig } from './config';

/**
 * Minimal production web client (M4-lite). Served at `/`, it lets a user sign
 * in with GitHub and claim a link code to bind a machine to their account —
 * the browser half of the linking flow. The full M4 client (live terminal
 * view) builds on this same page + endpoints.
 *
 * Everything runs against the existing JSON endpoints (/auth/github/login,
 * /api/me, /api/machines, /link/claim), so this is just a static shell.
 */
export function createWebClient(config: RelayConfig) {
  const page = renderPage(!config.isProduction);
  return function webRoute(req: Request): Response | null {
    const url = new URL(req.url);
    if (url.pathname === '/' && req.method === 'GET') {
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return null;
  };
}

function renderPage(devMode: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Bodhilander — Remote Hosting</title>
<style>
  :root { color-scheme: light dark; --accent: #0e7c86; }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 -apple-system, system-ui, sans-serif; max-width: 620px; margin: 0 auto; padding: 44px 20px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #888; margin: 0 0 28px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: #888; margin: 0 0 12px; }
  .card { border: 1px solid #8883; border-radius: 12px; padding: 18px; margin: 14px 0; }
  input { font: inherit; padding: 9px 11px; border: 1px solid #8886; border-radius: 7px; width: 170px; text-transform: uppercase; letter-spacing: .04em; background: transparent; color: inherit; }
  button { font: inherit; padding: 9px 15px; border: 0; border-radius: 7px; background: var(--accent); color: #fff; cursor: pointer; }
  button.ghost { background: #8883; color: inherit; }
  button:disabled { opacity: .5; cursor: default; }
  a.btn { display: inline-block; text-decoration: none; padding: 9px 15px; border-radius: 7px; background: #24292f; color: #fff; }
  code { background: #8882; padding: 1px 6px; border-radius: 5px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .banner { padding: 11px 14px; border-radius: 8px; margin: 10px 0 0; }
  .ok { background: #1f8f4e22; } .err { background: #e5534b22; }
  .muted { color: #888; font-size: 13px; }
  .machine { border: 1px solid #8883; border-radius: 9px; padding: 12px 14px; margin: 8px 0; }
  .machine .name { font-weight: 600; }
  .machine .fp { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #888; word-break: break-all; }
  .hidden { display: none; }
</style>
</head>
<body>
  <h1>🛰️ Bodhilander Remote Hosting</h1>
  <p class="sub">Link a desktop to your account so you can reach it from anywhere.</p>

  <div class="card" id="authCard">
    <h2>Account</h2>
    <div id="signedOut">
      <p class="muted">Sign in to link and manage your machines.</p>
      <a class="btn" href="/auth/github/login">Sign in with GitHub</a>
      ${devMode ? '<button class="ghost" id="devLogin" style="margin-left:10px">Dev sign in</button>' : ''}
    </div>
    <div id="signedIn" class="hidden">
      <div class="row"><span id="who"></span> <button class="ghost" id="logout">Sign out</button></div>
    </div>
  </div>

  <div class="card hidden" id="claimCard">
    <h2>Link a machine</h2>
    <p class="muted">In the desktop app: <strong>Settings → Remote Hosting → Generate link code</strong>, then enter it here.</p>
    <div class="row"><input id="code" placeholder="XXXX-XXXX" maxlength="9" /> <button id="claim">Link</button></div>
    <div id="claimResult"></div>
  </div>

  <div class="card hidden" id="machinesCard">
    <h2>Your machines</h2>
    <div id="machines"></div>
  </div>

<script>
const $ = (id) => document.getElementById(id);
const opts = { credentials: 'same-origin' };
const j = (r) => r.json().catch(() => ({}));

async function refresh() {
  const meRes = await fetch('/api/me', opts);
  const signedIn = meRes.ok;
  $('signedOut').classList.toggle('hidden', signedIn);
  $('signedIn').classList.toggle('hidden', !signedIn);
  $('claimCard').classList.toggle('hidden', !signedIn);
  $('machinesCard').classList.toggle('hidden', !signedIn);
  if (!signedIn) return;
  const { user } = await j(meRes);
  $('who').textContent = 'Signed in as ' + user.displayName + (user.email ? ' (' + user.email + ')' : '');
  const { machines } = await j(await fetch('/api/machines', opts));
  $('machines').innerHTML = machines.length
    ? machines.map((m) => '<div class="machine"><div class="name">' + esc(m.name) + '</div><div class="muted">linked ' + new Date(m.createdAt).toLocaleString() + '</div></div>').join('')
    : '<p class="muted">No machines linked yet.</p>';
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function banner(el, ok, msg) { el.innerHTML = '<div class="banner ' + (ok ? 'ok' : 'err') + '">' + msg + '</div>'; }

$('claim').onclick = async () => {
  const code = $('code').value.trim();
  if (!code) return;
  const r = await fetch('/link/claim', { ...opts, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const body = await j(r);
  if (r.ok) {
    banner($('claimResult'), true, 'Linked <code>' + esc(body.machine.name) + '</code>. Confirm its fingerprint matches the desktop before trusting it.');
    $('code').value = '';
    refresh();
  } else {
    banner($('claimResult'), false, 'Could not link: ' + (body.error || r.status));
  }
};
$('logout').onclick = async () => { await fetch('/auth/logout', { ...opts, method: 'POST' }); refresh(); };
const dev = $('devLogin');
if (dev) dev.onclick = async () => { await fetch('/dev/login', { ...opts, method: 'POST' }); refresh(); };
refresh();
</script>
</body>
</html>`;
}
