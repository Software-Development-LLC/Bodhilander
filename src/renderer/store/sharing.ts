import { useState, useEffect, useCallback } from 'react';
import { ShareUser } from '../../shared/types';

interface SharingState {
  user: ShareUser | null;
  isLoading: boolean;
}

export function useSharing() {
  const [state, setState] = useState<SharingState>({
    user: null,
    isLoading: true,
  });

  // Load initial auth state
  useEffect(() => {
    const loadUser = async () => {
      try {
        // Try to load saved token
        const savedToken = localStorage.getItem('claudelander_auth_token');
        if (savedToken) {
          const user = await window.electronAPI.setAuthToken(savedToken);
          if (user) {
            setState({ user, isLoading: false });
            return;
          }
        }
      } catch (e) {
        console.error('Failed to restore auth:', e);
      }
      setState({ user: null, isLoading: false });
    };

    loadUser();

    // Listen for auth changes - store cleanup functions
    const unsubscribeAuthChanged = window.electronAPI.onAuthChanged((data: any) => {
      setState({ user: data.user, isLoading: false });
      if (data.token) {
        try {
          localStorage.setItem('claudelander_auth_token', data.token);
        } catch (e) {
          console.error('Failed to save auth token:', e);
        }
      }
    });

    const unsubscribeAuthError = window.electronAPI.onAuthError((data: any) => {
      console.error('Auth error:', data.error);
      setState({ user: null, isLoading: false });
    });

    // Cleanup listeners on unmount
    return () => {
      unsubscribeAuthChanged?.();
      unsubscribeAuthError?.();
    };
  }, []);

  const login = useCallback(() => {
    window.electronAPI.login();
  }, []);

  const logout = useCallback(() => {
    window.electronAPI.logout();
    try {
      localStorage.removeItem('claudelander_auth_token');
    } catch (e) {
      console.error('Failed to remove auth token:', e);
    }
    setState({ user: null, isLoading: false });
  }, []);

  return {
    user: state.user,
    isLoading: state.isLoading,
    isAuthenticated: state.user !== null,
    login,
    logout,
  };
}
