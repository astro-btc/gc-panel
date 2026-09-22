const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  fetchPublic: (url) => ipcRenderer.invoke('public:fetch', url),
  credentialStatus: () => ipcRenderer.invoke('credentials:status'),
  saveCredentials: (apiKey, apiSecret) => ipcRenderer.invoke('credentials:save', { apiKey, apiSecret }),
  clearCredentials: () => ipcRenderer.invoke('credentials:clear'),
  gateCall: (action, payload) => ipcRenderer.invoke('gate:call', { action, payload }),
});
