import { contextBridge, ipcRenderer } from 'electron';

// Set up sound player for testing sounds in settings
ipcRenderer.on('sound:play', (_, { path, volume }) => {
  try {
    const audio = new Audio(`file://${path}`);
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.play().catch((err) => {
      console.warn('Failed to play sound:', err);
    });
  } catch (err) {
    console.warn('Failed to create audio:', err);
  }
});

contextBridge.exposeInMainWorld('settingsAPI', {
  getPreference: (key: string): Promise<string | null> =>
    ipcRenderer.invoke('prefs:get', key),

  setPreference: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('prefs:set', key, value),

  getAllSettings: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke('prefs:getAll'),

  // Sound notifications
  testSound: (event: 'waiting' | 'error' | 'start' | 'complete', volume?: number, customPath?: string): Promise<void> =>
    ipcRenderer.invoke('sound:test', event, volume, customPath),

  selectSoundFile: (): Promise<string | null> =>
    ipcRenderer.invoke('sound:selectFile'),

  // Expose platform for shell path suggestions
  platform: process.platform,

  // GitHub auth
  githubLogin: (): Promise<void> => ipcRenderer.invoke('auth:login'),
  githubLogout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
  githubGetUser: (): Promise<{ username: string; avatarUrl: string } | null> =>
    ipcRenderer.invoke('auth:getUser'),

  // Teams auth
  teamsLogin: (): Promise<void> => ipcRenderer.invoke('teams:login'),
  teamsLogout: (): Promise<void> => ipcRenderer.invoke('teams:logout'),
  teamsGetStatus: (): Promise<{ connected: boolean; user: { email: string; displayName: string } | null }> =>
    ipcRenderer.invoke('teams:getStatus'),
  teamsTestNotification: (): Promise<boolean> => ipcRenderer.invoke('teams:testNotification'),
});

// Listen for auth state changes and dispatch to window
ipcRenderer.on('auth:changed', (_, data) => {
  window.dispatchEvent(new CustomEvent('github-auth-changed', { detail: data }));
});

ipcRenderer.on('teams:authChanged', (_, data) => {
  window.dispatchEvent(new CustomEvent('teams-auth-changed', { detail: data }));
});
