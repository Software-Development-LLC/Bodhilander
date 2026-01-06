import { shell, BrowserWindow } from 'electron';
import { getPreference, setPreference } from '../repositories/preferences';
import {
  TEAMS_CLIENT_ID,
  TEAMS_REDIRECT_URI,
  TEAMS_SCOPES,
  TEAMS_AUTH_URL,
  TEAMS_TOKEN_URL,
  GRAPH_API_URL,
} from '../../shared/teams-constants';
import log from 'electron-log';
import crypto from 'crypto';
import http from 'http';

interface TeamsTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TeamsUser {
  email: string;
  displayName: string;
}

class TeamsAuthService {
  private tokens: TeamsTokens | null = null;
  private user: TeamsUser | null = null;
  private codeVerifier: string | null = null;
  private callbackServer: http.Server | null = null;

  get isAuthenticated(): boolean {
    return this.tokens !== null && Date.now() < this.tokens.expiresAt;
  }

  get currentUser(): TeamsUser | null {
    return this.user;
  }

  /**
   * Initialize from stored tokens
   */
  async initialize(): Promise<void> {
    const storedTokens = getPreference('teamsTokens');
    if (storedTokens) {
      try {
        this.tokens = JSON.parse(storedTokens);
        if (this.tokens && Date.now() >= this.tokens.expiresAt) {
          await this.refreshAccessToken();
        }
        if (this.tokens) {
          await this.fetchUserInfo();
        }
      } catch (e) {
        log.error('Failed to restore Teams tokens:', e);
        this.logout();
      }
    }
  }

  /**
   * Generate PKCE code verifier and challenge
   */
  private generatePKCE(): { verifier: string; challenge: string } {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64url');
    return { verifier, challenge };
  }

  /**
   * Start OAuth flow with localhost callback server
   */
  startLogin(): void {
    // Close any existing server
    if (this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;
    }

    const { verifier, challenge } = this.generatePKCE();
    this.codeVerifier = verifier;

    // Start temporary HTTP server to catch the callback
    this.callbackServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '', `http://localhost:8374`);

      if (url.pathname === '/auth/teams/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authentication Failed</h1><p>You can close this window.</p><script>window.close()</script></body></html>');
          log.error('Teams OAuth error:', error);
          this.closeCallbackServer();
          this.notifyAuthChange({ error, connected: false });
          return;
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authentication Successful</h1><p>You can close this window and return to ClaudeLander.</p><script>window.close()</script></body></html>');

          try {
            const user = await this.handleCallback(code);
            this.notifyAuthChange({ user, connected: true });
          } catch (e) {
            log.error('Teams callback handling failed:', e);
            this.notifyAuthChange({ error: (e as Error).message, connected: false });
          }

          this.closeCallbackServer();
          return;
        }
      }

      res.writeHead(404);
      res.end('Not found');
    });

    this.callbackServer.listen(8374, () => {
      log.info('Teams OAuth callback server listening on port 8374');
    });

    // Build auth URL and open browser
    const params = new URLSearchParams({
      client_id: TEAMS_CLIENT_ID,
      response_type: 'code',
      redirect_uri: TEAMS_REDIRECT_URI,
      scope: TEAMS_SCOPES.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      response_mode: 'query',
    });

    const authUrl = `${TEAMS_AUTH_URL}?${params.toString()}`;
    shell.openExternal(authUrl);

    // Auto-close server after 5 minutes (timeout)
    setTimeout(() => {
      this.closeCallbackServer();
    }, 5 * 60 * 1000);
  }

  /**
   * Close the callback server
   */
  private closeCallbackServer(): void {
    if (this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;
    }
  }

  /**
   * Notify renderer of auth state change
   */
  private notifyAuthChange(data: { user?: TeamsUser; error?: string; connected: boolean }): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('teams:authChanged', data);
      }
    });
  }

  /**
   * Handle OAuth callback
   */
  async handleCallback(code: string): Promise<TeamsUser> {
    if (!this.codeVerifier) {
      throw new Error('No code verifier - start login first');
    }

    const response = await fetch(TEAMS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TEAMS_CLIENT_ID,
        grant_type: 'authorization_code',
        code,
        redirect_uri: TEAMS_REDIRECT_URI,
        code_verifier: this.codeVerifier,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const data = await response.json();
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    this.codeVerifier = null;

    this.saveTokens();
    await this.fetchUserInfo();

    return this.user!;
  }

  /**
   * Refresh access token
   */
  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      throw new Error('No refresh token');
    }

    const response = await fetch(TEAMS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TEAMS_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
      }),
    });

    if (!response.ok) {
      this.logout();
      throw new Error('Token refresh failed');
    }

    const data = await response.json();
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || this.tokens.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    this.saveTokens();
  }

  /**
   * Get valid access token (refresh if needed)
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      throw new Error('Not authenticated');
    }

    if (Date.now() >= this.tokens.expiresAt - 60000) {
      await this.refreshAccessToken();
    }

    return this.tokens.accessToken;
  }

  /**
   * Fetch user info from Graph API
   */
  private async fetchUserInfo(): Promise<void> {
    const token = await this.getAccessToken();
    const response = await fetch(`${GRAPH_API_URL}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch user info');
    }

    const data = await response.json();
    this.user = {
      email: data.mail || data.userPrincipalName,
      displayName: data.displayName,
    };
  }

  /**
   * Save tokens to preferences
   */
  private saveTokens(): void {
    if (this.tokens) {
      setPreference('teamsTokens', JSON.stringify(this.tokens));
    }
  }

  /**
   * Logout
   */
  logout(): void {
    this.tokens = null;
    this.user = null;
    setPreference('teamsTokens', '');
  }
}

export const teamsAuthService = new TeamsAuthService();
