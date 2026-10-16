// Sandboxed preload: exposes the native folder picker, the Dock badge count and attention alerts to the page.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('languageAssistant', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  setAttentionCount: (count) => ipcRenderer.send('attention-count', count),
  alert: (payload) => ipcRenderer.send('attention-alert', payload),
});
