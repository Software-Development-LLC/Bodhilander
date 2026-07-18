import type { GithubProfile } from '../repositories';

/**
 * Minimal GitHub OAuth (web application flow). The `fetch` implementation is
 * injectable so tests exercise the exchange without network access. Only the
 * two scopes needed to identify a user are requested.
 */

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const EMAILS_URL = 'https://api.github.com/user/emails';
const SCOPE = 'read:user user:email';

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GithubOAuthError extends Error {}

export function buildAuthorizeUrl(config: GithubOAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCodeForProfile(
  config: GithubOAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubProfile> {
  const tokenRes = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  if (!tokenRes.ok) throw new GithubOAuthError(`token endpoint returned ${tokenRes.status}`);
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenJson.access_token) {
    throw new GithubOAuthError(`no access_token in response${tokenJson.error ? `: ${tokenJson.error}` : ''}`);
  }
  const token = tokenJson.access_token;

  const authHeaders = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'bodhilander-relay',
  };

  const userRes = await fetchImpl(USER_URL, { headers: authHeaders });
  if (!userRes.ok) throw new GithubOAuthError(`user endpoint returned ${userRes.status}`);
  const user = (await userRes.json()) as {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string | null;
    email: string | null;
  };

  let email = user.email;
  if (!email) {
    // The public profile often omits the email; the emails endpoint has it.
    try {
      const emailRes = await fetchImpl(EMAILS_URL, { headers: authHeaders });
      if (emailRes.ok) {
        const emails = (await emailRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
        email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
      }
    } catch {
      // Email is best-effort; identity is keyed on the provider user id.
    }
  }

  return {
    providerUserId: String(user.id),
    displayName: user.name?.trim() || user.login,
    email: email ?? null,
    avatarUrl: user.avatar_url,
  };
}
