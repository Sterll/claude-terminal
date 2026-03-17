/**
 * Discord Bot State Module
 * Manages bot server state, commands, and events
 */

const { State } = require('../../../renderer/state/State');

const initialState = {
  discordServers: new Map(),   // projectIndex -> { status, logs[], library, botName, guildCount }
  discordCommands: new Map(),  // projectIndex -> { commands[], loading, lastScan }
  discordEvents: new Map()     // projectIndex -> [{ timestamp, type, data }]
};

const discordState = new State(initialState);

function getDiscordServer(projectIndex) {
  return discordState.get().discordServers.get(projectIndex) || {
    status: 'stopped',
    logs: [],
    library: null,
    botName: null,
    guildCount: null
  };
}

function setDiscordServerStatus(projectIndex, status) {
  const servers = discordState.get().discordServers;
  const current = servers.get(projectIndex) || { status: 'stopped', logs: [], library: null, botName: null, guildCount: null };
  servers.set(projectIndex, { ...current, status });
  discordState.setProp('discordServers', servers);
}

function setDiscordBotInfo(projectIndex, { botName, guildCount }) {
  const servers = discordState.get().discordServers;
  const current = servers.get(projectIndex) || { status: 'stopped', logs: [], library: null, botName: null, guildCount: null };
  const update = { ...current };
  if (botName !== undefined) update.botName = botName;
  if (guildCount !== undefined) update.guildCount = guildCount;
  servers.set(projectIndex, update);
  discordState.setProp('discordServers', servers);
}

function setDiscordLibrary(projectIndex, library) {
  const servers = discordState.get().discordServers;
  const current = servers.get(projectIndex) || { status: 'stopped', logs: [], library: null, botName: null, guildCount: null };
  servers.set(projectIndex, { ...current, library });
  discordState.setProp('discordServers', servers);
}

function addDiscordLog(projectIndex, data) {
  const servers = discordState.get().discordServers;
  const current = servers.get(projectIndex) || { status: 'stopped', logs: [], library: null, botName: null, guildCount: null };
  const logs = [...current.logs, data];
  let combined = logs.join('');
  if (combined.length > 10000) combined = combined.slice(-10000);
  servers.set(projectIndex, { ...current, logs: [combined] });
  discordState.setProp('discordServers', servers);
}

function clearDiscordLogs(projectIndex) {
  const servers = discordState.get().discordServers;
  const current = servers.get(projectIndex);
  if (current) {
    servers.set(projectIndex, { ...current, logs: [] });
    discordState.setProp('discordServers', servers);
  }
}

function initDiscordServer(projectIndex) {
  const servers = discordState.get().discordServers;
  if (!servers.has(projectIndex)) {
    servers.set(projectIndex, { status: 'stopped', logs: [], library: null, botName: null, guildCount: null });
    discordState.setProp('discordServers', servers);
  }
}

function removeDiscordServer(projectIndex) {
  const servers = discordState.get().discordServers;
  servers.delete(projectIndex);
  discordState.setProp('discordServers', servers);
}

// Commands
function setDiscordCommands(projectIndex, commands) {
  const cmds = discordState.get().discordCommands;
  cmds.set(projectIndex, { commands, loading: false, lastScan: Date.now() });
  discordState.setProp('discordCommands', cmds);
}

function getDiscordCommands(projectIndex) {
  return discordState.get().discordCommands.get(projectIndex) || { commands: [], loading: false, lastScan: null };
}

function setDiscordCommandsLoading(projectIndex, loading) {
  const cmds = discordState.get().discordCommands;
  const current = cmds.get(projectIndex) || { commands: [], loading: false, lastScan: null };
  cmds.set(projectIndex, { ...current, loading });
  discordState.setProp('discordCommands', cmds);
}

// Events log
function addDiscordEvent(projectIndex, event) {
  const events = discordState.get().discordEvents;
  const current = events.get(projectIndex) || [];
  const updated = [...current, { ...event, timestamp: Date.now() }];
  // Keep last 100 events
  events.set(projectIndex, updated.slice(-100));
  discordState.setProp('discordEvents', events);
}

function getDiscordEvents(projectIndex) {
  return discordState.get().discordEvents.get(projectIndex) || [];
}

function clearDiscordEvents(projectIndex) {
  const events = discordState.get().discordEvents;
  events.set(projectIndex, []);
  discordState.setProp('discordEvents', events);
}

module.exports = {
  discordState,
  getDiscordServer,
  setDiscordServerStatus,
  setDiscordBotInfo,
  setDiscordLibrary,
  addDiscordLog,
  clearDiscordLogs,
  initDiscordServer,
  removeDiscordServer,
  setDiscordCommands,
  getDiscordCommands,
  setDiscordCommandsLoading,
  addDiscordEvent,
  getDiscordEvents,
  clearDiscordEvents
};
