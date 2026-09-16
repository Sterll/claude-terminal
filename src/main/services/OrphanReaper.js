/**
 * OrphanReaper — stops the CPU-hungry processes a Claude Code session leaves
 * behind once nothing is left to collect them.
 *
 * Every Bash tool call runs in a throwaway shell the CLI spawns in its own
 * process group:
 *
 *   /bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-<ts>-<id>.sh …
 *              && eval '<the command>' < /dev/null && pwd -P >| /tmp/claude-<hex>-cwd
 *
 * When the command returns, the CLI collects that shell. Nothing collects what
 * the command itself backgrounded with `&`: a subshell forked that way keeps
 * the tool shell's whole command line, is re-parented to pid 1 the moment the
 * tool shell exits, and runs until the machine reboots. The CLI's own teardown
 * only reaches the shell of a command that is *still running* — an interrupt
 * or a closed session kills that process group — never the leftovers of one
 * that already returned, and Claude Terminal never sees those processes at
 * all: they hang off a shell whose pid is gone.
 *
 * 2026-09-16: a session stress-testing a Go package started 3×nproc busy loops
 * with `(while :; do :; done) &` and cleaned up with `kill $(jobs -p)` — an
 * empty list in zsh, whose job table does not survive command substitution.
 * The 38 loops ran at close to eight cores for hours inside a healthy-looking
 * session, and only a process listing gave them away.
 *
 * Two rules, both restricted to processes carrying the tool-shell signature:
 *
 *   R1 leftover loop — orphaned, childless, burning CPU. Only a shell running
 *      nothing but builtins fits that shape, and a shell doing that is
 *      spinning. Killed per pid.
 *   R2 abandoned shell — an orphaned tool shell itself (its CLI died without
 *      the graceful teardown) whose process group is burning CPU. Killed as a
 *      group, which is exactly what the CLI would have done.
 *
 * Idle orphans are left alone: a dev server a command backgrounded on purpose
 * costs nothing and may well be wanted. And every kill needs the same verdict
 * on consecutive sweeps, so a shell caught in the milliseconds between its
 * CLI's exit and its own is never touched.
 *
 * POSIX only. Windows tool shells are not re-parented the same way and `ps`
 * is not there to read; `start()` is a no-op on win32.
 */

const fs = require('fs');
const { execFile } = require('child_process');

/** How often the process table is read. */
const SWEEP_INTERVAL_MS = 60 * 1000;
/** First sweep waits for the app to settle. */
const FIRST_SWEEP_DELAY_MS = 30 * 1000;
/**
 * Below this a shell is idle. A poll loop (`while :; do gh …; sleep 45; done`)
 * sits at 0% itself — the work is in its children. Oversubscribed busy loops
 * share cores, so the incident's 38 loops each showed ~20%: the bar has to be
 * well under what a single spinning shell would post.
 */
const CPU_THRESHOLD_PERCENT = 5;
/** Consecutive sweeps a candidate must be seen on before it is killed. */
const CONFIRMATIONS = 2;
/** Grace between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2000;

/**
 * What a Claude Code tool shell — and every subshell forked from it — carries
 * on its command line. Either half is enough: the snapshot is skipped when
 * snapshots are disabled, the cwd file is always there.
 */
const TOOL_SHELL_SIGNATURE = /shell-snapshots[\\/]snapshot-[a-z]+-\d+-[a-z0-9]+\.sh|claude-[0-9a-f]{4,}-cwd\b/;

const RULE_LEFTOVER_LOOP = 'leftover-loop';
const RULE_ABANDONED_SHELL = 'abandoned-shell';

/**
 * Parse `ps -Aww -o pid=,ppid=,pgid=,pcpu=,args=`.
 *
 * @param {string} text
 * @returns {Array<{pid:number, ppid:number, pgid:number, cpu:number, args:string}>}
 */
function parsePsOutput(text) {
  const rows = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      cpu: Number(m[4]),
      args: m[5],
    });
  }
  return rows;
}

/**
 * The command the tool shell was asked to run, lifted out of the wrapper so a
 * log line or a toast can say what was stopped. Falls back to the raw args.
 *
 * @param {string} args
 * @returns {string}
 */
function describeCommand(args) {
  const m = /eval '((?:[^']|'\\'')*)'/.exec(args);
  const cmd = m ? m[1].replace(/'\\''/g, "'") : args;
  const oneLine = cmd.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine;
}

/**
 * Pick, out of a process listing, what the two rules say should die.
 * Pure: no process is touched here.
 *
 * @param {ReturnType<typeof parsePsOutput>} rows
 * @param {{ cpuThreshold?: number }} [opts]
 * @returns {Array<{pid:number, pgid:number, rule:string, cpu:number, command:string}>}
 */
function classify(rows, { cpuThreshold = CPU_THRESHOLD_PERCENT } = {}) {
  const alive = new Set(rows.map(r => r.pid));
  const childCount = new Map();
  const groupCpu = new Map();
  for (const r of rows) {
    childCount.set(r.ppid, (childCount.get(r.ppid) || 0) + 1);
    groupCpu.set(r.pgid, (groupCpu.get(r.pgid) || 0) + r.cpu);
  }

  const out = [];
  for (const r of rows) {
    if (!TOOL_SHELL_SIGNATURE.test(r.args)) continue;
    // Its parent is gone: the tool shell (R1) or the CLI (R2) has exited.
    const orphaned = r.ppid <= 1 || !alive.has(r.ppid);
    if (!orphaned) continue;

    const isGroupLeader = r.pgid === r.pid;
    const isLeaf = !childCount.has(r.pid);

    if (isLeaf && r.cpu >= cpuThreshold) {
      out.push({ pid: r.pid, pgid: r.pgid, rule: RULE_LEFTOVER_LOOP, cpu: r.cpu, command: describeCommand(r.args) });
    } else if (isGroupLeader && (groupCpu.get(r.pgid) || 0) >= cpuThreshold) {
      out.push({ pid: r.pid, pgid: r.pgid, rule: RULE_ABANDONED_SHELL, cpu: groupCpu.get(r.pgid), command: describeCommand(r.args) });
    }
  }
  return out;
}

/** Read the process table. Rejects when `ps` is unavailable. */
function listProcesses() {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-Aww', '-o', 'pid=,ppid=,pgid=,pcpu=,args='], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(parsePsOutput(stdout));
    });
  });
}

/** The renderer owns settings.json; the switch defaults to on. */
function readEnabledSetting() {
  try {
    const { settingsFile } = require('../utils/paths');
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return s.orphanReaperEnabled !== false;
  } catch {
    return true;
  }
}

function defaultKill(pid, signal) {
  process.kill(pid, signal);
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but is not ours — then it was never a candidate.
    return e.code === 'EPERM';
  }
}

class OrphanReaper {
  /**
   * @param {object} [deps] - injectable for tests
   * @param {() => Promise<Array>} [deps.listProcesses]
   * @param {(pid:number, signal:string) => void} [deps.kill]
   * @param {(pid:number) => boolean} [deps.isAlive]
   * @param {() => boolean} [deps.isEnabled]
   * @param {(ms:number) => Promise<void>} [deps.delay]
   * @param {number} [deps.cpuThreshold]
   * @param {number} [deps.confirmations]
   */
  constructor(deps = {}) {
    this._listProcesses = deps.listProcesses || listProcesses;
    this._kill = deps.kill || defaultKill;
    this._isAlive = deps.isAlive || defaultIsAlive;
    this._isEnabled = deps.isEnabled || readEnabledSetting;
    this._delay = deps.delay || (ms => new Promise(r => setTimeout(r, ms)));
    this._cpuThreshold = deps.cpuThreshold ?? CPU_THRESHOLD_PERCENT;
    this._confirmations = deps.confirmations ?? CONFIRMATIONS;

    /** @type {Map<number, {rule:string, sightings:number}>} */
    this._suspects = new Map();
    this._timer = null;
    this._firstTimer = null;
    this._sweeping = false;
    this._mainWindow = null;
    /** @type {Array<(report: object) => void>} */
    this._listeners = [];
  }

  setMainWindow(win) {
    this._mainWindow = win;
  }

  /** @param {(report: {items: Array, totalCpu: number}) => void} fn */
  onReaped(fn) {
    this._listeners.push(fn);
  }

  start() {
    if (process.platform === 'win32' || this._timer || this._firstTimer) return;
    this._firstTimer = setTimeout(() => {
      this._firstTimer = null;
      this._timer = setInterval(() => this._tick(), SWEEP_INTERVAL_MS);
      this._timer.unref?.();
      this._tick();
    }, FIRST_SWEEP_DELAY_MS);
    this._firstTimer.unref?.();
  }

  stop() {
    if (this._firstTimer) clearTimeout(this._firstTimer);
    if (this._timer) clearInterval(this._timer);
    this._firstTimer = null;
    this._timer = null;
    this._suspects.clear();
  }

  _tick() {
    if (this._sweeping) return;
    this._sweeping = true;
    this.sweep()
      .catch(err => console.warn('[OrphanReaper] sweep failed:', err.message))
      .finally(() => { this._sweeping = false; });
  }

  /**
   * One pass: read the table, confirm suspects, kill the confirmed ones.
   *
   * @returns {Promise<{reaped: Array, totalCpu: number}>}
   */
  async sweep() {
    if (!this._isEnabled()) {
      this._suspects.clear();
      return { reaped: [], totalCpu: 0 };
    }

    const rows = await this._listProcesses();
    const candidates = classify(rows, { cpuThreshold: this._cpuThreshold });

    // Same pid, same rule, on consecutive sweeps — anything else starts over.
    const next = new Map();
    const confirmed = [];
    for (const c of candidates) {
      const prev = this._suspects.get(c.pid);
      const sightings = prev && prev.rule === c.rule ? prev.sightings + 1 : 1;
      if (sightings >= this._confirmations) confirmed.push(c);
      else next.set(c.pid, { rule: c.rule, sightings });
    }
    this._suspects = next;

    if (!confirmed.length) return { reaped: [], totalCpu: 0 };

    const reaped = await this._terminate(confirmed);
    if (reaped.length) {
      const totalCpu = Math.round(reaped.reduce((s, r) => s + r.cpu, 0));
      for (const r of reaped) {
        console.warn(`[OrphanReaper] stopped ${r.rule} pid=${r.pid} (${Math.round(r.cpu)}% CPU): ${r.command}`);
      }
      const report = { items: reaped, totalCpu };
      this._emit(report);
    }
    return { reaped, totalCpu: reaped.reduce((s, r) => s + r.cpu, 0) };
  }

  /**
   * SIGTERM first — a zsh loop honours it — then SIGKILL whatever is still
   * there after the grace. A group is addressed as `-pgid`.
   */
  async _terminate(targets) {
    const sent = [];
    for (const t of targets) {
      const target = t.rule === RULE_ABANDONED_SHELL ? -t.pgid : t.pid;
      try {
        this._kill(target, 'SIGTERM');
        sent.push({ ...t, target });
      } catch (_) {
        // Already gone, or not ours — either way not our problem any more.
      }
    }
    if (!sent.length) return [];

    await this._delay(KILL_GRACE_MS);
    for (const t of sent) {
      if (!this._isAlive(t.pid)) continue;
      try { this._kill(t.target, 'SIGKILL'); } catch (_) { /* raced its own exit */ }
    }
    return sent.map(({ target, ...rest }) => rest);
  }

  _emit(report) {
    for (const fn of this._listeners) {
      try { fn(report); } catch (e) { console.warn('[OrphanReaper] listener failed:', e.message); }
    }
    const win = this._mainWindow;
    if (win && !win.isDestroyed?.()) {
      try { win.webContents.send('orphan-reaper:reaped', report); } catch (_) { /* window closing */ }
    }
  }
}

const orphanReaper = new OrphanReaper();

module.exports = orphanReaper;
module.exports.OrphanReaper = OrphanReaper;
module.exports.parsePsOutput = parsePsOutput;
module.exports.classify = classify;
module.exports.describeCommand = describeCommand;
module.exports._internals = {
  TOOL_SHELL_SIGNATURE,
  RULE_LEFTOVER_LOOP,
  RULE_ABANDONED_SHELL,
  CPU_THRESHOLD_PERCENT,
  CONFIRMATIONS,
  SWEEP_INTERVAL_MS,
  KILL_GRACE_MS,
};
