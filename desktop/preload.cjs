// Sandboxed preload: exposes the native folder picker, the Dock badge count, attention alerts and "Open in Finder"
// (a session-relative path the main process resolves through the server) and the update notice to the page.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gloss', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  setAttentionCount: (count) => ipcRenderer.send('attention-count', count),
  alert: (payload) => ipcRenderer.send('attention-alert', payload),
  revealPath: (sessionId, relativePath) =>
    ipcRenderer.invoke('reveal-path', { sessionId, relativePath }),
  updates: {
    // Returns an unsubscribe function. The state is the full UpdateState; state() reads it once, e.g. after a reload.
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('update-state', listener);
      return () => ipcRenderer.removeListener('update-state', listener);
    },
    state: () => ipcRenderer.invoke('update-state'),
    check: () => ipcRenderer.invoke('update-check'),
    install: () => ipcRenderer.invoke('update-install'),
  },
});
