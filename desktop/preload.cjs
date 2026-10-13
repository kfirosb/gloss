// Sandboxed preload: exposes only the native folder picker to the page.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('languageAssistant', { pickFolder: () => ipcRenderer.invoke('pick-folder') });
