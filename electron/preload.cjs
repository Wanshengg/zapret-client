const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zapret', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  connect: (strategy) => ipcRenderer.invoke('app:connect', strategy),
  disconnect: () => ipcRenderer.invoke('app:disconnect'),
  selectStrategy: (strategy) => ipcRenderer.invoke('app:select-strategy', strategy),
  checkUpdates: () => ipcRenderer.invoke('app:check-updates'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  setSettings: (settings) => ipcRenderer.invoke('app:set-settings', settings),
  openGitHub: () => ipcRenderer.invoke('app:open-github'),
  clearHistory: () => ipcRenderer.invoke('app:clear-history'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
});
