/**
 * Preload for QuickPickerWindow
 * Exposes a single pickerAPI object via contextBridge
 */

const { ipcRenderer, contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

contextBridge.exposeInMainWorld('pickerAPI', {
  send: (channel, data) => ipcRenderer.send(channel, data),
  onReloadProjects: (fn) => ipcRenderer.on('reload-projects', (event, ...args) => fn(...args)),
  readProjects: () => {
    try {
      const projectsFile = path.join(os.homedir(), '.claude-terminal', 'projects.json');
      if (fs.existsSync(projectsFile)) {
        return JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      }
    } catch (_) {}
    return null;
  },
  readWorkflows: () => {
    try {
      const definitionsFile = path.join(os.homedir(), '.claude-terminal', 'workflows', 'definitions.json');
      if (fs.existsSync(definitionsFile)) {
        return JSON.parse(fs.readFileSync(definitionsFile, 'utf8'));
      }
    } catch (_) {}
    return [];
  },
  readAccentColor: () => {
    try {
      const settingsFile = path.join(os.homedir(), '.claude-terminal', 'settings.json');
      if (fs.existsSync(settingsFile)) {
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        return settings.accentColor || null;
      }
    } catch (_) {}
    return null;
  },
  readLanguage: () => {
    try {
      const settingsFile = path.join(os.homedir(), '.claude-terminal', 'settings.json');
      if (fs.existsSync(settingsFile)) {
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        return settings.language || 'fr';
      }
    } catch (_) {}
    return 'fr';
  }
});
