/**
 * Discord Bot Renderer Service
 * IPC wrappers for renderer process
 */

const { setDiscordServerStatus, setDiscordBotInfo, addDiscordLog, setDiscordLibrary, setDiscordCommands, setDiscordCommandsLoading } = require('./DiscordState');

const api = window.electron_api;

async function startBot(projectIndex) {
  const { projectsState } = require('../../../renderer/state');
  const project = projectsState.get().projects[projectIndex];
  if (!project) return { success: false, error: 'Project not found' };

  setDiscordServerStatus(projectIndex, 'starting');
  try {
    const result = await api.discord.start({
      projectIndex,
      projectPath: project.path,
      startCommand: project.startCommand
    });
    if (!result.success) {
      setDiscordServerStatus(projectIndex, 'stopped');
    }
    return result;
  } catch (e) {
    setDiscordServerStatus(projectIndex, 'stopped');
    return { success: false, error: e.message };
  }
}

async function stopBot(projectIndex) {
  try {
    const result = await api.discord.stop({ projectIndex });
    setDiscordServerStatus(projectIndex, 'stopped');
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function detectLibrary(projectIndex) {
  const { projectsState } = require('../../../renderer/state');
  const project = projectsState.get().projects[projectIndex];
  if (!project) return null;

  try {
    const lib = await api.discord.detectLibrary({ projectPath: project.path });
    if (lib) setDiscordLibrary(projectIndex, lib);
    return lib;
  } catch (e) {
    return null;
  }
}

async function scanCommands(projectIndex) {
  const { projectsState } = require('../../../renderer/state');
  const project = projectsState.get().projects[projectIndex];
  if (!project) return [];

  setDiscordCommandsLoading(projectIndex, true);
  try {
    const commands = await api.discord.scanCommands({ projectPath: project.path });
    setDiscordCommands(projectIndex, commands || []);
    return commands || [];
  } catch (e) {
    setDiscordCommandsLoading(projectIndex, false);
    return [];
  }
}

/**
 * Register IPC listeners for Discord data/exit/status events
 */
function registerListeners() {
  if (!api.discord) return;

  api.discord.onData(({ projectIndex, data }) => {
    addDiscordLog(projectIndex, data);
  });

  api.discord.onExit(({ projectIndex }) => {
    setDiscordServerStatus(projectIndex, 'stopped');
    setDiscordBotInfo(projectIndex, { botName: null, guildCount: null });
  });

  api.discord.onStatusChange(({ projectIndex, status, botName, guildCount }) => {
    if (status) setDiscordServerStatus(projectIndex, status);
    if (botName !== undefined || guildCount !== undefined) {
      setDiscordBotInfo(projectIndex, { botName, guildCount });
    }
  });
}

module.exports = {
  startBot,
  stopBot,
  detectLibrary,
  scanCommands,
  registerListeners
};
