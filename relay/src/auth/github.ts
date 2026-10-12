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
const BASE_SCOPE = 'read:user user:email';
/** Needed to read the user's org memberships (including private) for gating. */
const ORG_SCOPE = 'read:org';

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GithubOAuthError extends Error {}
/** Sign-in was valid but the user isn't an active member of the required org. */
export class OrgMembershipError extends GithubOAuthError {}

export function buildAuthorizeUrl(config: GithubOAuthConfig, state: string, includeOrgScope = false): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', includeOrgScope ? `${BASE_SCOPE} ${ORG_SCOPE}` : BASE_SCOPE);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Exchange the OAuth code for the user's profile. When `requiredOrg` is set,
 * the user must be an active member of that GitHub org or `OrgMembershipError`
 * is thrown (needs the read:org scope, which buildAuthorizeUrl requests when
 * gating is on).
 */
export async function exchangeCodeForProfile(
  config: GithubOAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
  requiredOrg: string | null = null,
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
    const detail = tokenJson.error ? `: ${tokenJson.error}` : '';
    throw new GithubOAuthError(`no access_token in response${detail}`);
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

  if (requiredOrg) {
    await assertOrgMembership(requiredOrg, authHeaders, fetchImpl, user.login);
  }

  return {
    providerUserId: String(user.id),
    displayName: user.name?.trim() || user.login,
    // The handle itself, kept separately from displayName. Sharing needs an
    // identifier the account holder cannot choose to impersonate someone else
    // with, and `name` is free text.
    login: user.login,
    email: email ?? null,
    avatarUrl: user.avatar_url,
  };
}

/**
 * Throw OrgMembershipError unless the token's user is an active member of
 * `org`. Uses the authenticated-user memberships endpoint, which reports the
 * caller's own membership including private (with read:org).
 */
async function assertOrgMembership(
  org: string,
  authHeaders: Record<string, string>,
  fetchImpl: typeof fetch,
  login: string,
): Promise<void> {
  const res = await fetchImpl(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`, {
    headers: authHeaders,
  });
  if (res.ok) {
    const body = (await res.json()) as { state?: string };
    if (body.state === 'active') return;
  } else if (res.status !== 404 && res.status !== 403) {
    // 404/403 = not a member / not visible → deny. Anything else is unexpected.
    throw new GithubOAuthError(`org membership check failed (${res.status})`);
  }
  throw new OrgMembershipError(`${login} is not an active member of ${org}`);
}
