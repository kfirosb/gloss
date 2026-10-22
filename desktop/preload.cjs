// Sandboxed preload: exposes the native folder picker, the Dock badge count, attention alerts and "Open in Finder"
// (a session-relative path the main process resolves through the server) to the page.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gloss', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  setAttentionCount: (count) => ipcRenderer.send('attention-count', count),
  alert: (payload) => ipcRenderer.send('attention-alert', payload),
  revealPath: (sessionId, relativePath) =>
    ipcRenderer.invoke('reveal-path', { sessionId, relativePath }),
});
