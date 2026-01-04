import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  checkForUpdate: () => ipcRenderer.invoke('app:check-for-update'),
});
