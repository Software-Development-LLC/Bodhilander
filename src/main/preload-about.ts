import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  checkForUpdate: () => ipcRenderer.invoke('app:check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('app:download-update'),
  onDownloadProgress: (callback: (percent: number) => void) => {
    ipcRenderer.on('update:progress', (_event, percent) => callback(percent));
  },
  onUpdateDownloaded: (callback: (version: string) => void) => {
    ipcRenderer.on('update:downloaded', (_event, version) => callback(version));
  },
  onDownloadError: (callback: (error: string) => void) => {
    ipcRenderer.on('update:error', (_event, error) => callback(error));
  },
  restartAndUpdate: () => ipcRenderer.invoke('app:restart-and-update'),
  closeWindow: () => ipcRenderer.send('about:close'),
});
