// Sandboxed preload: exposes the native folder picker and the Dock badge count to the page.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('languageAssistant', { pickFolder: () => ipcRenderer.invoke('pick-folder'), setAttentionCount: count => ipcRenderer.send('attention-count', count) });
