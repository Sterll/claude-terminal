const { ipcRenderer, contextBridge } = require('electron');
const settings = () => ipcRenderer.sendSync('window-read-data', 'settings');
const channels = new Set(['notification-action', 'notification-dismiss', 'notification-resize']);
contextBridge.exposeInMainWorld('notifAPI', {
  send: (channel, data) => { if (channels.has(channel)) ipcRenderer.send(channel, data); },
  readSettingsAccentColor: () => settings()?.accentColor || null,
  readSettingsLanguage: () => settings()?.language || 'en',
});
