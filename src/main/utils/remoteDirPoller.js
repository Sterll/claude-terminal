/**
 * Change detection for the remote directories the file explorer has expanded
 * (design/remote-ssh.md section 5.5).
 *
 * chokidar and `fs.watch` cannot watch a path on another machine, and no
 * agent runs on the host to push changes (section 9), so this polls: every
 * `intervalMs`, one batched request per host lists every expanded directory
 * of that host (`remoteFs.listDirs`), the answer is diffed against the
 * previous snapshot, and the differences go out as the same
 * `{ type: 'add'|'remove', path, isDirectory }` changes chokidar produces, on
 * the same `explorer:changes` channel. FileExplorer cannot tell the two apart.
 *
 * Rules that keep it cheap and honest:
 *   - nothing is asked while `isActive()` is false (the explorer is hidden or
 *     the window is not focused); a return to active polls at once;
 *   - nothing is asked of a host that is not connected, and the snapshots are
 *     kept, so the first listing after a reconnect reports whatever changed
 *     while the host was away (the resync);
 *   - one request in flight per host; a tick that finds one running skips it;
 *   - when the handshake found `inotifywait`, a one-shot
 *     `inotifywait -m` process watches the same directories and every event
 *     it prints triggers a listing at once, so the periodic poll drops to a
 *     slow resync. If that process ends on its own, the host falls back to
 *     plain polling.
 *
 * Paths are `ssh-remote://` URIs throughout. `authorize` puts each one inside
 * a registered project without contacting the host (the explorer asks to
 * watch the selected project's root on every selection, startup restore
 * included, and nothing may connect then); the remote blocklist is applied at
 * poll time, once the connected host has reported its home directory.
 */

'use strict';

const remotePath = require('../../shared/remote-path');
const { createRemoteFs, isBlockedRemotePath } = require('./remoteFs');
const { q } = require('../../shared/remote-shell');

const POLL_MS = 4000;
const INOTIFY_RESYNC_MS = 30000;
const INOTIFY_DEBOUNCE_MS = 300;
const INOTIFY_RESTART_MS = 500;
const INOTIFY_RETRY_AFTER_MS = 60000;
const INOTIFY_MAX_DIRS = 200;

/**
 * The inotifywait command for a set of directories: one line per event,
 * naming the directory.
 *
 * sshd does not signal a command without a terminal when its connection goes
 * away, and inotifywait only writes (and so only meets the broken pipe) on an
 * event. A watcher on a quiet directory would therefore outlive every restart
 * (each focus change, each expanded folder), holding one of the user's
 * inotify instances on the host until none were left. So the script binds
 * inotifywait to the session: the caller keeps ssh's stdin open, a sibling
 * reads it, and its end of file (the local ssh stopped, for whatever reason)
 * kills the watcher. A watcher that ends on its own still ends the script with
 * its status, so the poller can fall back to polling.
 */
function inotifyScript(dirs) {
  const watch = `inotifywait -m -q -e create -e delete -e moved_from -e moved_to --format '%w' -- ${dirs.map((d) => q(d)).join(' ')}`;
  return [
    'exec 3<&0',
    `${watch} </dev/null & p=$!`,
    '{ cat <&3 >/dev/null 2>&1; kill $p 2>/dev/null; } & w=$!',
    'exec 3<&-',
    'wait $p; s=$?',
    'kill $w 2>/dev/null',
    'exit $s',
  ].join('; ');
}

/**
 * @param {object} deps
 * @param {{ getStatus: Function, runner: Function, on?: Function, removeListener?: Function }} deps.service
 * @param {(uri: string) => Promise<{profileId: string, path: string}>} deps.authorize
 * @param {() => boolean} deps.isActive
 * @param {(changes: Array<{type: string, path: string, isDirectory: boolean}>) => void} deps.emit
 */
function createRemoteDirPoller({
  service,
  authorize,
  isActive,
  emit,
  intervalMs = POLL_MS,
  resyncMs = INOTIFY_RESYNC_MS,
  createFs = createRemoteFs,
  isBlocked = isBlockedRemotePath,
  timers = { setInterval, clearInterval, setTimeout, clearTimeout },
  now = () => Date.now(),
  useInotify = true,
} = {}) {
  /** uri -> { profileId, path, ownerId, snapshot: Map<name, boolean>|null } */
  const dirs = new Map();
  /** profileId -> { busy, lastPoll, inotify: { abort, dirsKey }|null, inotifyBlockedUntil, restartTimer, debounceTimer, wasConnected } */
  const hosts = new Map();
  let interval = null;
  let disposed = false;

  function hostState(profileId) {
    if (!hosts.has(profileId)) {
      hosts.set(profileId, {
        busy: false, lastPoll: 0, inotify: null, inotifyBlockedUntil: 0,
        restartTimer: null, debounceTimer: null, wasConnected: false, dirty: false,
      });
    }
    return hosts.get(profileId);
  }

  function dirsOf(profileId) {
    const out = [];
    for (const entry of dirs.values()) if (entry.profileId === profileId) out.push(entry);
    return out;
  }

  function connected(profileId) {
    const status = service.getStatus(profileId);
    return status && status.state === 'connected' ? status : null;
  }

  function hasInotify(status) {
    return useInotify && !!(status && status.capabilities && Array.isArray(status.capabilities.tools) && status.capabilities.tools.includes('inotifywait'));
  }

  function ensureInterval() {
    if (interval || disposed || dirs.size === 0) return;
    interval = timers.setInterval(() => { tick().catch(() => {}); }, intervalMs);
  }

  function stopIntervalIfIdle() {
    if (dirs.size > 0 || !interval) return;
    timers.clearInterval(interval);
    interval = null;
  }

  // ── inotify ──

  function stopInotify(profileId) {
    const h = hosts.get(profileId);
    if (!h) return;
    if (h.restartTimer) { timers.clearTimeout(h.restartTimer); h.restartTimer = null; }
    if (h.debounceTimer) { timers.clearTimeout(h.debounceTimer); h.debounceTimer = null; }
    if (h.inotify) {
      const { controller } = h.inotify;
      h.inotify = null;
      try { controller.abort(); } catch { /* already over */ }
    }
  }

  function scheduleInotify(profileId) {
    const h = hostState(profileId);
    if (h.restartTimer) timers.clearTimeout(h.restartTimer);
    h.restartTimer = timers.setTimeout(() => {
      h.restartTimer = null;
      syncInotify(profileId);
    }, INOTIFY_RESTART_MS);
  }

  /** Start, restart or stop the host's inotifywait so it watches exactly the expanded directories. */
  function syncInotify(profileId) {
    const h = hostState(profileId);
    const status = connected(profileId);
    const home = status && status.capabilities && status.capabilities.home;
    const paths = dirsOf(profileId).filter((d) => !isBlocked(d.path, home, 'read')).map((d) => d.path).sort();
    const want = !disposed && status && hasInotify(status) && isActive() && paths.length > 0
      && paths.length <= INOTIFY_MAX_DIRS && now() >= h.inotifyBlockedUntil && typeof service.oneShot === 'function';
    const key = paths.join('\0');
    if (!want) { stopInotify(profileId); return; }
    if (h.inotify && h.inotify.key === key) return;
    stopInotify(profileId);
    const controller = new AbortController();
    const run = { controller, key, buffer: '' };
    h.inotify = run;
    service.oneShot(profileId, inotifyScript(paths), {
      signal: controller.signal,
      timeoutMs: 6 * 60 * 60 * 1000,
      maxBuffer: 1024 * 1024,
      // The script ends the remote watcher on stdin's end of file (see inotifyScript).
      keepStdinOpen: true,
      onStdout: (chunk) => {
        if (h.inotify !== run) return;
        run.buffer = (run.buffer + chunk.toString('utf8')).slice(-65536);
        if (!run.buffer.includes('\n')) return;
        run.buffer = run.buffer.slice(run.buffer.lastIndexOf('\n') + 1);
        h.dirty = true;
        if (h.debounceTimer) timers.clearTimeout(h.debounceTimer);
        h.debounceTimer = timers.setTimeout(() => {
          h.debounceTimer = null;
          pollHost(profileId).catch(() => {});
        }, INOTIFY_DEBOUNCE_MS);
      },
    }).then(() => {
      // Ended without being asked to (inotifywait missing after all, the
      // watch limit reached, the connection dropped): poll instead for a while.
      if (h.inotify === run) {
        h.inotify = null;
        h.inotifyBlockedUntil = now() + INOTIFY_RETRY_AFTER_MS;
      }
    }, () => {
      if (h.inotify === run) {
        h.inotify = null;
        h.inotifyBlockedUntil = now() + INOTIFY_RETRY_AFTER_MS;
      }
    });
  }

  // ── Polling ──

  function diff(profileId, entry, listing, changes) {
    const next = new Map();
    for (const e of listing.entries) next.set(e.name, e.isDirectory);
    const prev = entry.snapshot;
    entry.snapshot = listing.missing ? null : next;
    if (!prev || listing.missing) return;
    const childUri = (name) => remotePath.format(profileId, remotePath.join(entry.path, name));
    for (const [name, isDirectory] of prev) {
      if (!next.has(name) || next.get(name) !== isDirectory) {
        changes.push({ type: 'remove', path: childUri(name), isDirectory });
      }
    }
    for (const [name, isDirectory] of next) {
      if (!prev.has(name) || prev.get(name) !== isDirectory) {
        changes.push({ type: 'add', path: childUri(name), isDirectory });
      }
    }
  }

  /** One batched listing of every expanded directory of a host, diffed and emitted. */
  async function pollHost(profileId) {
    const h = hostState(profileId);
    if (disposed || h.busy || !isActive()) return;
    const status = connected(profileId);
    if (!status) return;
    // The blocklist needs the remote home, which only a connected host has
    // told us; a protected directory is simply never listed.
    const home = status.capabilities && status.capabilities.home;
    const entries = dirsOf(profileId).filter((e) => !isBlocked(e.path, home, 'read'));
    if (entries.length === 0) return;
    h.busy = true;
    h.dirty = false;
    h.lastPoll = now();
    try {
      const fsApi = createFs(service.runner(profileId));
      const listing = await fsApi.listDirs(entries.map((e) => e.path));
      h.wasConnected = true;
      const changes = [];
      for (const entry of entries) {
        // Unwatched while the request was out: its snapshot no longer matters.
        if (dirs.get(remotePath.format(profileId, entry.path)) !== entry) continue;
        const result = listing.get(entry.path);
        if (result) diff(profileId, entry, result, changes);
      }
      if (changes.length) emit(changes);
    } catch {
      // A dropped host or a timeout: the next tick tries again, and the
      // snapshots are kept so nothing is reported twice or lost.
    } finally {
      h.busy = false;
    }
  }

  /** The periodic tick: every host with expanded directories, unless inotify covers it. */
  async function tick() {
    if (disposed || !isActive()) return;
    const profiles = new Set([...dirs.values()].map((d) => d.profileId));
    const jobs = [];
    for (const profileId of profiles) {
      const h = hostState(profileId);
      const status = connected(profileId);
      if (!status) { h.wasConnected = false; continue; }
      const resync = !h.wasConnected;
      h.wasConnected = true;
      if (h.inotify && !resync && !h.dirty && now() - h.lastPoll < resyncMs) continue;
      jobs.push(pollHost(profileId));
    }
    await Promise.all(jobs);
  }

  /**
   * Start watching an expanded remote directory.
   * @param {string} uri
   * @param {number|null} [ownerId] webContents id, so a reload releases it
   */
  async function watch(uri, ownerId = null) {
    if (disposed) return false;
    const target = await authorize(uri);
    const key = remotePath.format(target.profileId, target.path);
    if (dirs.has(key)) return true;
    dirs.set(key, { profileId: target.profileId, path: target.path, ownerId, snapshot: null });
    ensureInterval();
    // A baseline right away, so the first real change is reported on the next tick.
    pollHost(target.profileId).catch(() => {});
    scheduleInotify(target.profileId);
    return true;
  }

  function unwatch(uri) {
    const parsed = remotePath.tryParse(uri);
    if (!parsed) return;
    const key = remotePath.format(parsed.profileId, parsed.path);
    if (!dirs.delete(key)) return;
    stopIntervalIfIdle();
    scheduleInotify(parsed.profileId);
  }

  function unwatchOwner(ownerId) {
    const touched = new Set();
    for (const [key, entry] of dirs) {
      if (entry.ownerId !== ownerId) continue;
      dirs.delete(key);
      touched.add(entry.profileId);
    }
    stopIntervalIfIdle();
    for (const profileId of touched) scheduleInotify(profileId);
  }

  function stopAll() {
    dirs.clear();
    for (const profileId of hosts.keys()) stopInotify(profileId);
    stopIntervalIfIdle();
  }

  /** The window, the explorer or a host changed: poll now if that made us active, stop inotify if not. */
  function kick() {
    for (const profileId of new Set([...dirs.values()].map((d) => d.profileId))) syncInotify(profileId);
    tick().catch(() => {});
  }

  /** A host's status changed: leaving `connected` stops its watcher; coming back resyncs at once. */
  function onStatus(status) {
    if (!status || !status.profileId) return;
    const h = hosts.get(status.profileId);
    if (!h) return;
    if (status.state !== 'connected') {
      h.wasConnected = false;
      stopInotify(status.profileId);
      return;
    }
    if (dirsOf(status.profileId).length) {
      scheduleInotify(status.profileId);
      tick().catch(() => {});
    }
  }
  if (typeof service.on === 'function') service.on('status', onStatus);

  function dispose() {
    stopAll();
    disposed = true;
    if (typeof service.removeListener === 'function') service.removeListener('status', onStatus);
  }

  return {
    watch, unwatch, unwatchOwner, stopAll, tick, kick, dispose,
    _dirs: dirs, _hosts: hosts,
  };
}

module.exports = { createRemoteDirPoller, inotifyScript, POLL_MS, INOTIFY_RESYNC_MS };
