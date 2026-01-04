import { shell } from 'electron';
import { RELAY_URL } from '../../shared/constants';
import { ShareUser } from '../../shared/types';
import log from 'electron-log';

interface AuthState {
  token: string | null;
  user: ShareUser | null;
}

class AuthService {
  private state: AuthState = {
    token: null,
    user: null,
  };

  get isAuthenticated(): boolean {
    return this.state.token !== null;
  }

  get currentUser(): ShareUser | null {
    return this.state.user;
  }

  get token(): string | null {
    return this.state.token;
  }

  /**
   * Start GitHub OAuth flow by opening browser
   */
  startLogin(): void {
    const authUrl = `${RELAY_URL}/auth/github`;
    shell.openExternal(authUrl);
  }

  /**
   * Handle the OAuth callback with token
   * Called when deep link claudelander://auth?token=xxx is received
   */
  async handleCallback(token: string): Promise<ShareUser> {
    this.state.token = token;

    // Fetch user info
    const response = await fetch(`${RELAY_URL}/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      this.state.token = null;
      throw new Error('Failed to fetch user info');
    }

    const user = (await response.json()) as ShareUser;
    this.state.user = user;

    log.info('User authenticated:', user.username);
    return user;
  }

  /**
   * Set token directly (for restoring from storage)
   */
  async setToken(token: string): Promise<ShareUser | null> {
    try {
      return await this.handleCallback(token);
    } catch (e) {
      log.error('Failed to restore token:', e);
      return null;
    }
  }

  /**
   * Log out
   */
  logout(): void {
    this.state.token = null;
    this.state.user = null;
  }

  /**
   * Get auth headers for API requests
   */
  getHeaders(): Record<string, string> {
    if (!this.state.token) {
      throw new Error('Not authenticated');
    }
    return {
      Authorization: `Bearer ${this.state.token}`,
      'Content-Type': 'application/json',
    };
  }
}

export const authService = new AuthService();
