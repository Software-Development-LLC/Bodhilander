import type { RelayConfig } from './config';
import type { Repositories } from './repositories';
import { serializeCookie, SESSION_COOKIE } from './auth/cookies';

/**
 * Development-only harness. Stands in for the real web client (M4) so the full
 * desktop → relay → online flow can be exercised locally without a GitHub OAuth
 * app: a fake sign-in and a link-code claim form.
 *
 * Mounted ONLY when NODE_ENV !== production (see http.ts). It must never exist
 * in a deployed relay.
 */
export function createDevRoutes(_config: RelayConfig, repos: Repositories) {
  return async function devRoute(req: Request): Promise<Response | null> {
    const url = new URL(req.url);

    if (url.pathname === '/' && req.method === 'GET') {
      return new Response(DEV_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/dev/login' && req.method === 'POST') {
      const user = repos.upsertGithubUser({
        providerUserId: 'dev-user',
        displayName: 'Dev User',
        email: 'dev@localhost',
        avatarUrl: null,
      });
      const { token } = repos.createSession(user.id, 24 * 60 * 60);
      return new Response(JSON.stringify({ ok: true, user: { id: user.id, displayName: user.display_name } }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': serializeCookie(SESSION_COOKIE, token, { secure: false, maxAgeSeconds: 86400 }),
        },
      });
    }

    return null; // not a dev route — fall through to the real router
  };
}

const DEV_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Relay — Dev Console</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 20px; } h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .05em; color: #888; margin-top: 28px; }
  .card { border: 1px solid #8883; border-radius: 10px; padding: 16px; margin: 10px 0; }
  input { font: inherit; padding: 8px 10px; border: 1px solid #8886; border-radius: 6px; width: 160px; text-transform: uppercase; }
  button { font: inherit; padding: 8px 14px; border: 0; border-radius: 6px; background: #0e7c86; color: #fff; cursor: pointer; }
  button.secondary { background: #8883; color: inherit; }
  code { background: #8882; padding: 1px 5px; border-radius: 4px; }
  .banner { padding: 10px 14px; border-radius: 8px; margin: 8px 0; }
  .ok { background: #1f8f4e22; } .err { background: #e5534b22; }
  pre { background: #8881; padding: 12px; border-radius: 8px; overflow-x: auto; }
  .muted { color: #888; font-size: 13px; }
</style>
</head>
<body>
  <h1>🛰️ Relay — Dev Console</h1>
  <p class="muted">Development stand-in for the web client. Sign in, then claim the link code your desktop generated.</p>

  <div class="card">
    <h2>1 · Sign in</h2>
    <div id="who" class="muted">Not signed in.</div>
    <p><button id="login">Dev sign in</button></p>
  </div>

  <div class="card">
    <h2>2 · Claim a link code</h2>
    <p><input id="code" placeholder="XXXX-XXXX" /> <button id="claim">Claim</button></p>
    <div id="claimResult"></div>
  </div>

  <div class="card">
    <h2>3 · Linked machines</h2>
    <button id="refresh" class="secondary">Refresh</button>
    <pre id="machines">—</pre>
  </div>

<script>
const $ = (id) => document.getElementById(id);
const j = (r) => r.json().catch(() => ({}));
function banner(el, ok, msg) { el.innerHTML = '<div class="banner ' + (ok ? 'ok' : 'err') + '">' + msg + '</div>'; }

async function me() {
  const r = await fetch('/api/me', { credentials: 'same-origin' });
  if (r.ok) { const { user } = await j(r); $('who').textContent = 'Signed in as ' + user.displayName; return true; }
  $('who').textContent = 'Not signed in.'; return false;
}
async function machines() {
  const r = await fetch('/api/machines', { credentials: 'same-origin' });
  if (!r.ok) { $('machines').textContent = '(sign in first)'; return; }
  const { machines } = await j(r);
  $('machines').textContent = machines.length ? JSON.stringify(machines, null, 2) : '(none yet)';
}
$('login').onclick = async () => { await fetch('/dev/login', { method: 'POST', credentials: 'same-origin' }); await me(); await machines(); };
$('claim').onclick = async () => {
  const code = $('code').value.trim();
  const r = await fetch('/link/claim', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const body = await j(r);
  if (r.ok) banner($('claimResult'), true, 'Linked: <code>' + body.machine.name + '</code> — your desktop should go Online.');
  else banner($('claimResult'), false, 'Failed: ' + (body.error || r.status));
  await machines();
};
$('refresh').onclick = machines;
me().then(machines);
</script>
</body>
</html>`;
