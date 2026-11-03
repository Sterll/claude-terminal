/**
 * HooksService
 * Manages Claude Code CLI hooks installation in ~/.claude/settings.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const CLAUDE_SETTINGS_BACKUP_PATH = path.join(os.homedir(), '.claude', 'settings.pre-hooks.json');

// Identifier used to detect our hooks in the config
const HOOK_IDENTIFIER = 'claude-terminal-hook-handler';

// Path to the bundled hook handler script (extraResources puts it alongside app.asar)
function getHandlerPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'hooks', 'claude-terminal-hook-handler.js');
  }
  return path.join(app.getAppPath(), 'resources', 'hooks', 'claude-terminal-hook-handler.js');
}

// Generated launcher used when no external `node` is reachable. Named after
// HOOK_IDENTIFIER on purpose: isOurHook() recognises our entries by that
// substring, so a launcher named anything else would make our own hooks
// invisible to the installer and pile up duplicates on every run.
const HOOKS_DATA_DIR = path.join(os.homedir(), '.claude-terminal', 'hooks');

function getLauncherPath() {
  const ext = process.platform === 'win32' ? '.cmd' : '.sh';
  return path.join(HOOKS_DATA_DIR, HOOK_IDENTIFIER + ext);
}

/**
 * Locate a `node` executable on the app's PATH.
 *
 * Walks PATH with fs rather than spawning `which`: this runs on the startup
 * path, and the app's PATH is what Claude Code inherits anyway, since the CLI
 * is spawned from this process. A GUI launch on macOS does not inherit the
 * login shell's PATH, so a node installed through nvm or Homebrew is commonly
 * invisible here — which is exactly the case the launcher fallback covers.
 *
 * @returns {string|null} Absolute path to node, or null when unreachable
 */
function findNodeOnPath() {
  const isWindows = process.platform === 'win32';
  const dirs = (process.env.PATH || '').split(isWindows ? ';' : ':').filter(Boolean);
  const extensions = isWindows
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, 'node' + ext.toLowerCase());
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch (e) {
        /* unreadable PATH entry, keep looking */
      }
    }
  }
  return null;
}

/**
 * Write the launcher that runs the handler through Electron's embedded Node.
 *
 * The ELECTRON_RUN_AS_NODE variable is set *inside* the script rather than
 * prefixed onto the hook command: `VAR=1 cmd` is shell syntax that cmd.exe
 * rejects, and the hook command line is executed by whichever shell Claude
 * Code picks. A launcher path is inert in every shell.
 *
 * @returns {string} Path to the launcher
 */
function writeLauncher() {
  const launcherPath = getLauncherPath();
  const runtime = process.execPath;
  const handlerPath = getHandlerPath();

  fs.mkdirSync(HOOKS_DATA_DIR, { recursive: true });

  if (process.platform === 'win32') {
    fs.writeFileSync(launcherPath, [
      '@echo off',
      'set ELECTRON_RUN_AS_NODE=1',
      `"${runtime}" "${handlerPath}" %1`,
      ''
    ].join('\r\n'), 'utf8');
  } else {
    fs.writeFileSync(launcherPath, [
      '#!/bin/sh',
      'export ELECTRON_RUN_AS_NODE=1',
      // exec, so the handler's exit code reaches Claude Code unchanged.
      // PermissionRequest encodes allow/deny as 0/2 and must not be swallowed.
      `exec "${runtime}" "${handlerPath}" "$1"`,
      ''
    ].join('\n'), 'utf8');
    fs.chmodSync(launcherPath, 0o755);
  }

  return launcherPath;
}

/**
 * Whether the hooks can call an external node rather than the launcher.
 *
 * On Windows the hooks spawn node without a shell (see buildHookCommand), and
 * Windows refuses to spawn a batch file that way, so a `node.cmd` shim counts
 * as no node at all: the launcher, run through cmd.exe, covers that machine.
 *
 * @returns {boolean}
 */
function hasUsableNode() {
  const node = findNodeOnPath();
  if (!node) return false;
  return process.platform !== 'win32' || /\.exe$/i.test(node);
}

/**
 * Build the command prefix every hook entry shares, minus the hook name, in
 * the shell form POSIX hooks use.
 *
 * Prefers an external node when one is reachable, which keeps the command
 * byte-identical to what previous versions wrote and spares healthy
 * installations a settings.json rewrite on upgrade.
 *
 * @returns {string}
 */
function buildHookInvocation() {
  if (hasUsableNode()) {
    return `node "${getHandlerPath().replace(/\\/g, '/')}"`;
  }
  return `"${getLauncherPath().replace(/\\/g, '/')}"`;
}

// Characters cmd.exe acts on even inside the path it is handed to run. A
// launcher path holding one of them (a profile folder named "Jean & Marie")
// would be split or stripped by `cmd /c`, and the hook would silently not run.
const CMD_SPECIAL = /[&|<>()@^%!"]/;

/**
 * The fields of the `command` hook that runs the handler for one hook key.
 *
 * POSIX keeps the shell form it always had. Windows does not, because there
 * the shell is not ours to count on: with Git for Windows the CLI runs a hook's
 * command through Git Bash, and without it through PowerShell, where
 * `"<launcher>" Key` is a parse error rather than a call. Since CLI 2.1.298 a
 * PreToolUse or PermissionRequest hook that fails that way blocks the tool
 * call instead of letting it through, so a machine with neither Git nor Node
 * had every tool call refused. Windows hooks therefore never go through a
 * shell when they can avoid it: the exec form (`args`, CLI 2.1.139+) spawns
 * node directly, and the launcher, a batch file that cannot be spawned
 * directly, through cmd.exe. Both behave the same with and without Git Bash,
 * and forward the handler's exit code (PermissionRequest answers 0 or 2).
 * Only a launcher path cmd.exe cannot be trusted with goes through PowerShell,
 * named explicitly and quoted for it, which also works either way.
 *
 * @param {string} hookKey
 * @returns {{ command: string, args?: string[], shell?: string }}
 */
function buildHookCommand(hookKey) {
  if (process.platform !== 'win32') {
    return { command: `${buildHookInvocation()} ${hookKey}` };
  }
  if (hasUsableNode()) {
    return { command: 'node', args: [getHandlerPath().replace(/\\/g, '/'), hookKey] };
  }
  return windowsLauncherCommand(getLauncherPath().replace(/\\/g, '/'), hookKey);
}

/**
 * How Windows runs a launcher at `launcherPath` for one hook key.
 * @param {string} launcherPath
 * @param {string} hookKey
 * @returns {{ command: string, args?: string[], shell?: string }}
 */
function windowsLauncherCommand(launcherPath, hookKey) {
  if (!CMD_SPECIAL.test(launcherPath)) {
    return { command: 'cmd.exe', args: ['/d', '/c', launcherPath, hookKey] };
  }
  return { shell: 'powershell', command: `& '${launcherPath.replace(/'/g, "''")}' ${hookKey}` };
}

/**
 * Whether a written hook runs exactly what `expected` describes. Compares the
 * fields buildHookCommand() sets, so a hook in the old Windows shell form, or
 * one that gained or lost `args` or `shell`, is not a match.
 * @param {Object} hook
 * @param {{ command: string, args?: string[], shell?: string }} expected
 * @returns {boolean}
 */
function sameHookCommand(hook, expected) {
  return hook.command === expected.command
    && JSON.stringify(hook.args) === JSON.stringify(expected.args)
    && hook.shell === expected.shell;
}

/**
 * All hooks to install.
 * Hooks with matcher support use matcher: "" (match all).
 * Hooks without matcher support omit the matcher field.
 */
const HOOK_DEFINITIONS = [
  { key: 'PreToolUse', hasMatcher: true },
  { key: 'PostToolUse', hasMatcher: true },
  { key: 'PostToolUseFailure', hasMatcher: true },
  { key: 'Notification', hasMatcher: true },
  { key: 'UserPromptSubmit', hasMatcher: false },
  { key: 'SessionStart', hasMatcher: true },
  { key: 'Stop', hasMatcher: false },
  { key: 'SubagentStart', hasMatcher: true },
  { key: 'SubagentStop', hasMatcher: true },
  { key: 'PreCompact', hasMatcher: true },
  { key: 'SessionEnd', hasMatcher: true },
  { key: 'PermissionRequest', hasMatcher: true },
  { key: 'Setup', hasMatcher: true },
  { key: 'TeammateIdle', hasMatcher: false },
  { key: 'TaskCompleted', hasMatcher: false },
  { key: 'ConfigChange', hasMatcher: true },
  { key: 'WorktreeCreate', hasMatcher: false },
  { key: 'WorktreeRemove', hasMatcher: false },
  // SDK 0.3.226+: a directory joined the session's working set, via /add-dir or
  // by registering a repo root. Lets the explorer and workflows react to scope changes.
  { key: 'DirectoryAdded', hasMatcher: false }
];

// Marker code carried by the error thrown when settings.json cannot be trusted
const SETTINGS_UNREADABLE = 'CLAUDE_SETTINGS_UNREADABLE';

/**
 * Build the error raised when settings.json exists but cannot be parsed/read.
 * Mutating functions must surface it instead of writing, otherwise the user's
 * permissions / env / model / statusLine would be replaced by a hooks-only file.
 * @param {string} reason
 * @returns {Error}
 */
function settingsUnreadableError(reason) {
  const err = new Error(
    `Claude settings.json is malformed, refusing to overwrite (${reason}). ` +
    `The file was left untouched at ${CLAUDE_SETTINGS_PATH}. ` +
    `A backup from a previous install may be available at ${CLAUDE_SETTINGS_BACKUP_PATH}.`
  );
  err.code = SETTINGS_UNREADABLE;
  return err;
}

/**
 * Read Claude settings.json.
 * Distinguishes "file absent" (returns {}, legitimate) from "malformed or
 * unreadable" (throws), so we never write over a file we failed to parse.
 * @returns {Object}
 * @throws {Error} with code SETTINGS_UNREADABLE when the file exists but is unusable
 */
function readClaudeSettings() {
  let raw;
  try {
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return {};
    raw = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8');
  } catch (e) {
    // The file disappeared between the check and the read: treat as absent
    if (e && e.code === 'ENOENT') return {};
    console.error('Failed to read Claude settings:', e);
    throw settingsUnreadableError(e.message);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse Claude settings:', e);
    throw settingsUnreadableError(e.message);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw settingsUnreadableError('root value is not a JSON object');
  }
  return parsed;
}

/**
 * Write Claude settings.json
 * @param {Object} settings
 */
function writeClaudeSettings(settings) {
  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Atomic write: write to temp file then rename to prevent corruption
  const tmpFile = CLAUDE_SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(settings, null, 2));
  try {
    fs.renameSync(tmpFile, CLAUDE_SETTINGS_PATH);
  } catch (renameErr) {
    // Fallback: direct write if rename fails (Windows antivirus lock)
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Create a backup of current Claude settings
 */
function backupSettings() {
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      fs.copyFileSync(CLAUDE_SETTINGS_PATH, CLAUDE_SETTINGS_BACKUP_PATH);
    }
  } catch (e) {
    console.error('Failed to backup Claude settings:', e);
  }
}

/**
 * Build a hook entry for a given hook definition
 * @param {Object} hookDef
 * @returns {Object}
 */
function buildHookEntry(hookDef) {
  const entry = {
    hooks: [
      {
        type: 'command',
        ...buildHookCommand(hookDef.key)
      }
    ]
  };
  if (hookDef.hasMatcher) {
    entry.matcher = '';
  }
  return entry;
}

/**
 * The strings of a command hook that can name our script: the command, and in
 * the exec form its arguments, where the handler or launcher path now lives.
 * @param {Object} hook
 * @returns {string[]}
 */
function hookStrings(hook) {
  const strings = typeof hook.command === 'string' ? [hook.command] : [];
  if (Array.isArray(hook.args)) strings.push(...hook.args.filter(a => typeof a === 'string'));
  return strings;
}

/**
 * Check if a hook entry is one of ours
 * @param {Object} hookEntry
 * @returns {boolean}
 */
function isOurHook(hookEntry) {
  if (!hookEntry || !Array.isArray(hookEntry.hooks)) return false;
  return hookEntry.hooks.some(h =>
    h && h.type === 'command' && hookStrings(h).some(s => s.includes(HOOK_IDENTIFIER))
  );
}

/**
 * Install Claude Terminal hooks into ~/.claude/settings.json
 * Non-destructive: appends alongside existing user hooks.
 * Aborts without writing if settings.json exists but cannot be parsed.
 * @returns {{ success: boolean, error?: string }}
 */
function installHooks() {
  try {
    // Throws on a malformed/unreadable file -> we abort before any write
    const settings = readClaudeSettings();

    // No external node: the hooks will point at the launcher, so it has to
    // exist (and carry current paths) before settings.json references it.
    if (!hasUsableNode()) {
      writeLauncher();
    }

    // Create backup before modifying
    backupSettings();

    // Ensure hooks object exists
    if (!settings.hooks) {
      settings.hooks = {};
    }

    for (const hookDef of HOOK_DEFINITIONS) {
      const hookKey = hookDef.key;
      const newEntry = buildHookEntry(hookDef);

      if (!settings.hooks[hookKey]) {
        // No existing hooks for this key - create array with our entry
        settings.hooks[hookKey] = [newEntry];
      } else {
        // Existing hooks - check if ours is already there
        const existing = settings.hooks[hookKey];
        const arr = Array.isArray(existing) ? existing : [existing];

        // Remove any existing hooks of ours (to update path if changed)
        const filtered = arr.filter(entry => !isOurHook(entry));

        // Append our hook
        filtered.push(newEntry);
        settings.hooks[hookKey] = filtered;
      }
    }

    writeClaudeSettings(settings);
    return { success: true };
  } catch (e) {
    console.error('Failed to install hooks:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Remove Claude Terminal hooks from ~/.claude/settings.json
 * Only removes our hooks (detected by HOOK_IDENTIFIER in command string).
 * Aborts without writing if settings.json exists but cannot be parsed.
 * @returns {{ success: boolean, error?: string }}
 */
function removeHooks() {
  try {
    // Throws on a malformed/unreadable file -> we abort before any write
    const settings = readClaudeSettings();

    if (!settings.hooks) {
      return { success: true };
    }

    for (const hookDef of HOOK_DEFINITIONS) {
      const hookKey = hookDef.key;
      if (!settings.hooks[hookKey]) continue;

      const existing = settings.hooks[hookKey];
      const arr = Array.isArray(existing) ? existing : [existing];

      // Filter out our hooks
      const filtered = arr.filter(entry => !isOurHook(entry));

      if (filtered.length === 0) {
        // No hooks left for this key - remove the key entirely
        delete settings.hooks[hookKey];
      } else {
        settings.hooks[hookKey] = filtered;
      }
    }

    // Remove empty hooks object
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    writeClaudeSettings(settings);
    return { success: true };
  } catch (e) {
    console.error('Failed to remove hooks:', e);
    return { success: false, error: e.message };
  }
}

/**
 * The handler or launcher path a hook of ours runs, or null when it cannot
 * be told. Covers every shape this service has written: the exec form (the
 * path is one of `args`), the shell forms `node "<handler>" Key` and
 * `"<launcher>" Key`, and PowerShell's `& '<launcher>' Key`.
 * @param {Object} hook
 * @returns {string|null}
 */
function hookTarget(hook) {
  if (!hook || hook.type !== 'command') return null;
  if (Array.isArray(hook.args)) {
    return hook.args.find(a => typeof a === 'string' && a.includes(HOOK_IDENTIFIER)) || null;
  }
  if (typeof hook.command !== 'string') return null;
  const quoted = [];
  for (const m of hook.command.matchAll(/"([^"]+)"|'((?:[^']|'')+)'/g)) {
    quoted.push(m[1] !== undefined ? m[1] : m[2].replace(/''/g, "'"));
  }
  return quoted.find(p => p.includes(HOOK_IDENTIFIER)) || null;
}

/**
 * Whether one of our entries points at a script that no longer exists.
 *
 * A command whose target cannot be told is reported alive, so an entry is
 * only ever pruned on positive evidence that its target is gone.
 *
 * @param {Object} hookEntry
 * @returns {boolean}
 */
function isDeadHook(hookEntry) {
  if (!isOurHook(hookEntry)) return false;
  return hookEntry.hooks.some(h => {
    const target = hookTarget(h);
    return !!target && !fs.existsSync(target);
  });
}

/**
 * The Windows hook that replaces one of ours still written in the shell form
 * earlier versions used, keeping the script it already ran, or null when it
 * is not in that form. That form blocks every tool call on a machine without
 * Git for Windows when it names the launcher (see buildHookCommand).
 * @param {Object} hook
 * @returns {Object|null}
 */
function windowsExecFormOf(hook) {
  if (!hook || hook.type !== 'command' || typeof hook.command !== 'string') return null;
  if (hook.args !== undefined || hook.shell !== undefined) return null;
  const viaNode = hook.command.match(/^node "([^"]+)" (\S+)$/);
  if (viaNode && viaNode[1].includes(HOOK_IDENTIFIER)) {
    return { ...hook, command: 'node', args: [viaNode[1], viaNode[2]] };
  }
  const viaLauncher = hook.command.match(/^"([^"]+)" (\S+)$/);
  if (viaLauncher && viaLauncher[1].includes(HOOK_IDENTIFIER)) {
    return { ...hook, ...windowsLauncherCommand(viaLauncher[1], viaLauncher[2]) };
  }
  return null;
}

/**
 * Remove our entries whose script no longer exists, and nothing else.
 *
 * Runs when hooks are disabled, which is exactly when verifyAndRepairHooks()
 * does not: an install that was moved or reinstalled under another directory
 * (the NSIS layout changed from `Programs/claude-terminal/Claude Terminal` to
 * `Programs/Claude Terminal`) otherwise leaves every Claude session printing a
 * MODULE_NOT_FOUND stack on each Stop, forever. Entries that still resolve are
 * left alone, as are every other tool's hooks and every hook key we do not
 * define today, since an older version may have installed one.
 *
 * On Windows a live entry of ours still in the old shell form is rewritten in
 * place (`migrated`), keeping the script it runs: it can belong to another
 * install sharing this settings.json, one with hooks on, and in that form it
 * blocks every tool call once Git for Windows is gone (see buildHookCommand).
 *
 * @returns {{ success: boolean, pruned: number, migrated: number, error?: string }}
 */
function pruneDeadHooks() {
  try {
    // Throws on a malformed/unreadable file -> we abort before any write
    const settings = readClaudeSettings();
    if (!settings.hooks || typeof settings.hooks !== 'object') {
      return { success: true, pruned: 0, migrated: 0 };
    }

    let pruned = 0;
    let migrated = 0;
    for (const hookKey of Object.keys(settings.hooks)) {
      const existing = settings.hooks[hookKey];
      const arr = Array.isArray(existing) ? existing : [existing];
      const kept = arr.filter(entry => !isDeadHook(entry));
      pruned += arr.length - kept.length;

      let changed = kept.length !== arr.length;
      const next = process.platform !== 'win32' ? kept : kept.map(entry => {
        if (!isOurHook(entry)) return entry;
        const hooks = entry.hooks.map(h => {
          const replacement = windowsExecFormOf(h);
          if (!replacement) return h;
          migrated++;
          changed = true;
          return replacement;
        });
        return { ...entry, hooks };
      });
      if (!changed) continue;

      if (next.length === 0) delete settings.hooks[hookKey];
      else settings.hooks[hookKey] = next;
    }

    if (pruned === 0 && migrated === 0) return { success: true, pruned: 0, migrated: 0 };
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeClaudeSettings(settings);
    return { success: true, pruned, migrated };
  } catch (e) {
    console.error('Failed to prune dead hooks:', e);
    return { success: false, pruned: 0, migrated: 0, error: e.message };
  }
}

/**
 * Check if our hooks are currently installed
 * @returns {{ installed: boolean, count: number }}
 */
function areHooksInstalled() {
  try {
    const settings = readClaudeSettings();

    if (!settings.hooks) {
      return { installed: false, count: 0 };
    }

    let count = 0;
    for (const hookDef of HOOK_DEFINITIONS) {
      const hookKey = hookDef.key;
      if (!settings.hooks[hookKey]) continue;

      const existing = settings.hooks[hookKey];
      const arr = Array.isArray(existing) ? existing : [existing];

      if (arr.some(entry => isOurHook(entry))) {
        count++;
      }
    }

    return {
      installed: count === HOOK_DEFINITIONS.length,
      count
    };
  } catch (e) {
    console.error('Failed to check hooks status:', e);
    return { installed: false, count: 0 };
  }
}

/**
 * Verify hooks integrity and repair if needed.
 * Checks:
 * 1. Handler script exists at expected path
 * 2. The launcher exists, when hooks run through it rather than external node
 * 3. All hooks are present in ~/.claude/settings.json
 * 4. Each hook runs exactly what this version writes: current app location
 *    (handles app move/update), current runtime, and on Windows the form that
 *    needs no shell, so hooks installed in the old shell form are rewritten
 * Silently reinstalls if anything is wrong.
 * @returns {{ ok: boolean, repaired: boolean, details?: string }}
 */
function verifyAndRepairHooks() {
  try {
    const handlerPath = getHandlerPath();

    // 1. Check handler script exists
    const handlerExists = fs.existsSync(handlerPath);
    if (!handlerExists) {
      return { ok: false, repaired: false, details: 'Handler script missing: ' + handlerPath };
    }

    // 2. In launcher mode the generated script must exist too. It lives in the
    // user's data dir, so it can be deleted independently of the app.
    if (!hasUsableNode() && !fs.existsSync(getLauncherPath())) {
      const result = installHooks();
      return {
        ok: result.success,
        repaired: result.success,
        details: 'Launcher missing, regenerated'
      };
    }

    // 2. Read current hooks from Claude settings.
    // Throws on a malformed file -> reported as not ok, never repaired blindly
    const settings = readClaudeSettings();
    if (!settings.hooks) {
      // No hooks at all — reinstall
      const result = installHooks();
      return { ok: result.success, repaired: result.success, details: 'No hooks found, reinstalled' };
    }

    // 3. Check each hook: present + correct path
    let missingCount = 0;
    let stalePathCount = 0;

    for (const hookDef of HOOK_DEFINITIONS) {
      const hookKey = hookDef.key;
      const arr = settings.hooks[hookKey];
      if (!arr) {
        missingCount++;
        continue;
      }

      const entries = Array.isArray(arr) ? arr : [arr];
      const ourEntry = entries.find(entry => isOurHook(entry));

      if (!ourEntry) {
        missingCount++;
        continue;
      }

      // Mode-aware: node may have appeared or disappeared since install, the
      // app may have moved, and a Windows hook may still be in the shell form.
      // Any of those makes this entry stale.
      const ourHook = ourEntry.hooks.find(h => hookTarget(h)) || ourEntry.hooks[0];
      if (!sameHookCommand(ourHook, buildHookCommand(hookKey))) {
        stalePathCount++;
      }
    }

    if (missingCount === 0 && stalePathCount === 0) {
      return { ok: true, repaired: false };
    }

    // Something is wrong — reinstall (installHooks removes old + adds fresh)
    const result = installHooks();
    const details = [];
    if (missingCount > 0) details.push(`${missingCount} hooks missing`);
    if (stalePathCount > 0) details.push(`${stalePathCount} hooks with stale path`);

    return {
      ok: result.success,
      repaired: result.success,
      details: details.join(', ') + ' — reinstalled'
    };
  } catch (e) {
    console.error('Failed to verify hooks:', e);
    return { ok: false, repaired: false, details: e.message };
  }
}

module.exports = {
  installHooks,
  removeHooks,
  areHooksInstalled,
  verifyAndRepairHooks,
  pruneDeadHooks,
  // Exported for tests and diagnostics: which runtime the hooks will use.
  findNodeOnPath,
  getLauncherPath,
  buildHookInvocation,
  buildHookCommand
};
