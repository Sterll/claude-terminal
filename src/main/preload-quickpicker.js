const { ipcRenderer, contextBridge } = require('electron');
const read = kind => ipcRenderer.sendSync('window-read-data', kind);
const channels = new Set(['quick-pick-select', 'quick-pick-command', 'quick-pick-workflow', 'quick-pick-close']);
contextBridge.exposeInMainWorld('pickerAPI', {
  send: (channel, data) => { if (channels.has(channel)) ipcRenderer.send(channel, data); },
  onReloadProjects: fn => ipcRenderer.on('reload-projects', (_event, ...args) => fn(...args)),
  readProjects: () => read('projects'),
  readWorkflows: () => read('workflows') || [],
  readAccentColor: () => read('settings')?.accentColor || null,
  readLanguage: () => read('settings')?.language || 'fr',
});
