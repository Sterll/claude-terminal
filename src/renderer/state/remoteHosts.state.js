/**
 * Remote Hosts State Module
 *
 * The renderer's mirror of the SSH host profiles and of each host's connection
 * state, so the project list, the project bar and the Open Remote Project
 * dialog can draw a host badge synchronously on every repaint.
 *
 * The main process owns all of it (SshHostService, remote-hosts.json). This
 * module never writes a profile itself: it asks main through the `ssh` bridge,
 * then republishes what comes back, and folds in the `ssh-status-changed`
 * broadcasts. Nothing here carries a secret, and nothing here connects on its
 * own at startup: loading lists the profiles and their current state, and a
 * host connects only when the user opens one of its projects or clicks the
 * badge (design/remote-ssh.md section 6).
 *
 * Hosts are let go again: once no open project uses a host, it is
 * disconnected after IDLE_DISCONNECT_MS, which is also what stops a host
 * nobody is looking at from retrying forever.
 */

const { State } = require('./State');
const { projectsState } = require('./projects.state');
const { isRemoteProject } = require('../../shared/remote-capabilities');
const remotePath = require('../../shared/remote-path');

/** A host no open project uses is disconnected after this long. */
const IDLE_DISCONNECT_MS = 10 * 60 * 1000;

/** States in which nothing connects until the user acts (mirrors SshHostService). */
const STOPPED_STATES = new Set(['offline', 'authFailed', 'hostKeyUnknown', 'hostKeyChanged', 'unsupported']);

/** States a project open may start a connection from, without the user asking twice. */
const AUTO_CONNECT_FROM = new Set(['idle', 'offline']);

const initialState = {
  profiles: [],
  statuses: {},     // profileId -> { profileId, state, detail, retryAt, capabilities }
  loaded: false,
  error: null,      // { code, message } when remote-hosts.json could not be read
};

const remoteHostsState = new State(initialState);

const _idleTimers = new Map();   // profileId -> timeout handle
const _holds = new Map();        // profileId -> number of active holds (open dialogs)
let _unwatch = null;

function _api() {
  return (typeof window !== 'undefined' && window.electron_api && window.electron_api.ssh) || null;
}

/** Display form of a profile's destination: the alias, else user@host[:port]. */
function hostLabelOf(profile) {
  if (!profile) return '';
  if (profile.sshConfigAlias) return profile.sshConfigAlias;
  const user = profile.user ? `${profile.user}@` : '';
  const port = profile.port && Number(profile.port) !== 22 ? `:${profile.port}` : '';
  return `${user}${profile.host || ''}${port}`;
}

/**
 * Pull the profile list and the current statuses from main. Never connects.
 * A store main refuses to read leaves the previous list in place and records
 * the error, rather than repainting every remote project as unconfigured.
 * @returns {Promise<void>}
 */
async function loadRemoteHosts() {
  const api = _api();
  if (!api || typeof api.listProfiles !== 'function') return;
  let res;
  try {
    res = await api.listProfiles();
  } catch (e) {
    remoteHostsState.set({ loaded: true, error: { code: 'ipc', message: e && e.message ? e.message : String(e) } });
    return;
  }
  if (!res || !res.success) {
    remoteHostsState.set({ loaded: true, error: { code: (res && res.code) || 'unknown', message: (res && res.error) || '' } });
    return;
  }
  const statuses = { ...remoteHostsState.get().statuses };
  for (const status of res.statuses || []) {
    if (status && status.profileId) statuses[status.profileId] = status;
  }
  remoteHostsState.set({ profiles: Array.isArray(res.profiles) ? res.profiles : [], statuses, loaded: true, error: null });
  _reviewIdle();
}

/** Fold one `ssh-status-changed` payload into the mirror. */
function applyHostStatus(status) {
  if (!status || !status.profileId) return;
  const statuses = { ...remoteHostsState.get().statuses, [status.profileId]: status };
  remoteHostsState.set({ statuses });
  _reviewIdle();
}

/**
 * Subscribe to main's status broadcasts, forward the window's `online` event
 * (main retries hosts waiting out a backoff), and watch which projects are
 * open for the idle disconnect. Returns the unsubscribe function.
 * @returns {Function}
 */
function watchRemoteHosts() {
  if (_unwatch) return _unwatch;
  const api = _api();
  const offs = [];
  if (api && typeof api.onStatusChanged === 'function') {
    const off = api.onStatusChanged(applyHostStatus);
    if (typeof off === 'function') offs.push(off);
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onOnline = () => {
      try { _api()?.networkOnline?.(); } catch (_) { /* best effort */ }
    };
    window.addEventListener('online', onOnline);
    offs.push(() => window.removeEventListener('online', onOnline));
  }
  offs.push(projectsState.subscribe(() => _reviewIdle()));
  _unwatch = () => {
    for (const off of offs) { try { off(); } catch (_) { /* already gone */ } }
    for (const timer of _idleTimers.values()) clearTimeout(timer);
    _idleTimers.clear();
    _unwatch = null;
  };
  return _unwatch;
}

function getHostProfiles() {
  return remoteHostsState.get().profiles;
}

function getHostProfile(profileId) {
  if (!profileId) return null;
  return remoteHostsState.get().profiles.find(p => p.id === profileId) || null;
}

/** The last known status of a host; `idle` for one never connected. */
function getHostStatus(profileId) {
  return remoteHostsState.get().statuses[profileId]
    || { profileId, state: 'idle', detail: null, retryAt: null, capabilities: null };
}

/**
 * Everything a view needs to badge a project, or null for a local project.
 *
 * `state` is the host's connection state, or `unconfigured` when the project
 * names a profile this machine does not have (a project synced in from
 * another machine), or `unsupported` with `store-unreadable` when main could
 * not read remote-hosts.json at all.
 *
 * @param {Object} project
 * @returns {null|{profileId: string|null, remotePath: string, hostLabel: string, profile: Object|null, state: string, status: Object}}
 */
function getProjectHost(project) {
  if (!isRemoteProject(project)) return null;
  const parsed = remotePath.tryParse(project.path);
  const profileId = (project.remote && project.remote.profileId) || (parsed && parsed.profileId) || null;
  const remoteDir = (project.remote && project.remote.path) || (parsed && parsed.path) || '';
  const { loaded, error } = remoteHostsState.get();
  const profile = getHostProfile(profileId);
  const hostLabel = (profile && hostLabelOf(profile)) || (project.remote && project.remote.hostLabel) || '';
  const status = getHostStatus(profileId);
  let state = status.state;
  if (error && !profile) {
    state = 'unsupported';
    return { profileId, remotePath: remoteDir, hostLabel, profile, state, status: { ...status, state, detail: { code: 'store-unreadable' } } };
  }
  if (loaded && !profile) state = 'unconfigured';
  return { profileId, remotePath: remoteDir, hostLabel, profile, state, status };
}

/**
 * Connect a host on an explicit user action (the badge, a Connect menu item,
 * the Open Remote Project dialog). Retries a stopped state too: the user asked.
 * @returns {Promise<Object|null>} the resulting status
 */
async function connectHost(profileId) {
  const api = _api();
  if (!api || !profileId) return null;
  try {
    const res = await api.connect(profileId);
    if (res && res.success && res.status) {
      applyHostStatus(res.status);
      return res.status;
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function disconnectHost(profileId) {
  const api = _api();
  if (!api || !profileId) return null;
  try {
    const res = await api.disconnect(profileId);
    if (res && res.success && res.status) applyHostStatus(res.status);
    return res && res.status ? res.status : null;
  } catch (_) {
    return null;
  }
}

/**
 * The user opened a project. For a remote project whose host is configured
 * and not connected yet, start connecting. A stopped state that needs a human
 * (auth failure, host key) is left alone: the badge explains it, and retrying
 * an auth failure on every click is how an account gets locked.
 *
 * Deliberately not hooked to selection in general: the startup restore selects
 * a project too, and nothing may connect at startup.
 *
 * @param {Object} project
 * @returns {Promise<Object|null>}
 */
function connectProjectHost(project) {
  const host = getProjectHost(project);
  if (!host || !host.profile) return Promise.resolve(null);
  if (!AUTO_CONNECT_FROM.has(host.state)) return Promise.resolve(host.status);
  return connectHost(host.profileId);
}

/**
 * Keep a host from being idle-disconnected while something outside the
 * project list uses it (the Open Remote Project dialog browsing it).
 * @returns {Function} release
 */
function holdHost(profileId) {
  if (!profileId) return () => {};
  _holds.set(profileId, (_holds.get(profileId) || 0) + 1);
  _reviewIdle();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (_holds.get(profileId) || 1) - 1;
    if (n <= 0) _holds.delete(profileId); else _holds.set(profileId, n);
    _reviewIdle();
  };
}

/** Profiles some open project (a project-bar tab, or the selected one) uses. */
function _profilesInUse() {
  const inUse = new Set(_holds.keys());
  const { projects = [], openProjectIds = [], selectedProjectFilter } = projectsState.get();
  const open = new Set(openProjectIds);
  projects.forEach((project, index) => {
    if (!open.has(project.id) && index !== selectedProjectFilter) return;
    const host = isRemoteProject(project) ? (project.remote?.profileId || remotePath.tryParse(project.path)?.profileId) : null;
    if (host) inUse.add(host);
  });
  return inUse;
}

function _reviewIdle() {
  const inUse = _profilesInUse();
  const { statuses } = remoteHostsState.get();
  for (const [profileId, status] of Object.entries(statuses)) {
    const active = status && status.state !== 'idle' && !STOPPED_STATES.has(status.state);
    if (!active || inUse.has(profileId)) {
      const timer = _idleTimers.get(profileId);
      if (timer) { clearTimeout(timer); _idleTimers.delete(profileId); }
      continue;
    }
    if (_idleTimers.has(profileId)) continue;
    _idleTimers.set(profileId, setTimeout(() => {
      _idleTimers.delete(profileId);
      if (_profilesInUse().has(profileId)) return;
      disconnectHost(profileId);
    }, IDLE_DISCONNECT_MS));
  }
}

// ── Profiles (main owns the store) ──

/**
 * Save a profile through main. Only the editor's own fields are sent; there is
 * no secret among them, and main refuses any field it does not know.
 * @returns {Promise<{success: boolean, profile?: Object, error?: string}>}
 */
async function saveHostProfile(fields) {
  const api = _api();
  if (!api) return { success: false, error: 'SSH bridge unavailable' };
  const res = await api.saveProfile(fields);
  if (res && res.success) await loadRemoteHosts();
  return res || { success: false };
}

async function deleteHostProfile(profileId) {
  const api = _api();
  if (!api) return { success: false, error: 'SSH bridge unavailable' };
  const res = await api.deleteProfile(profileId);
  if (res && res.success) {
    const statuses = { ...remoteHostsState.get().statuses };
    delete statuses[profileId];
    remoteHostsState.set({ statuses });
    await loadRemoteHosts();
  }
  return res || { success: false };
}

/** Test for the editor: a throwaway connection that does not change the host's state. */
async function testHostProfile(profileId) {
  const api = _api();
  if (!api) return { success: false, error: 'SSH bridge unavailable' };
  return api.testProfile(profileId);
}

/** Test hook: forget timers, holds and the subscription. */
function _resetForTests() {
  if (_unwatch) _unwatch();
  for (const timer of _idleTimers.values()) clearTimeout(timer);
  _idleTimers.clear();
  _holds.clear();
  remoteHostsState.set({ profiles: [], statuses: {}, loaded: false, error: null });
}

module.exports = {
  remoteHostsState,
  IDLE_DISCONNECT_MS,
  hostLabelOf,
  loadRemoteHosts,
  applyHostStatus,
  watchRemoteHosts,
  getHostProfiles,
  getHostProfile,
  getHostStatus,
  getProjectHost,
  connectHost,
  disconnectHost,
  connectProjectHost,
  holdHost,
  saveHostProfile,
  deleteHostProfile,
  testHostProfile,
  _resetForTests,
};
