/**
 * Which shell a terminal tab runs, and which terminal application "Open in
 * external terminal" starts (issue #255).
 *
 * Two settings, read in main from settings.json, never taken from an IPC
 * argument:
 *
 * - `terminalShell` picks the program a plain shell tab's PTY runs: '' for the
 *   historical default (PowerShell on Windows, $SHELL elsewhere, unchanged
 *   byte for byte), the id of a detected shell, or 'custom' with
 *   `terminalShellCustomPath` / `terminalShellCustomArgs`. Claude tabs and
 *   remote tabs never read it: the first launch `claude` (on POSIX through the
 *   default shell, whose syntax the typed command line assumes), the second
 *   run the login shell of the host.
 * - `externalTerminal` picks the terminal application opened on a folder: ''
 *   for this platform's usual one, a detected id, or 'custom' with
 *   `externalTerminalCustomCommand`, where `{path}` stands for the folder.
 *   `externalTerminalProfile` is handed to Windows Terminal as `-p`.
 *
 * Settings travel between machines with cloud sync, so an id this machine does
 * not have, or a custom path that does not exist here, is not an error: the
 * shell falls back to the default and says so in the tab, the external
 * terminal refuses with a sentence naming the setting.
 *
 * Nothing here goes through a shell, except on Windows where a new console
 * window can only come from `start`: a detached process gets no console at all
 * (libuv sets DETACHED_PROCESS), and an attached one would be killed with the
 * app (libuv's kill-on-close job). That one cmd.exe command line is built from
 * quoted arguments that refuse the characters cmd still reads inside quotes.
 *
 * Every function takes an optional `deps` ({ platform, env, isFile, isDir,
 * readFile, realpath, spawn }) so all three platforms are testable anywhere.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Environment ──────────────────────────────────────────────────────────────

function _deps(deps = {}) {
  const platform = deps.platform || process.platform;
  return {
    platform,
    env: deps.env || process.env,
    pathApi: platform === 'win32' ? path.win32 : path.posix,
    isFile: deps.isFile || ((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch (e) {
        // App execution aliases (WindowsApps\wt.exe, the Store's pwsh.exe) are
        // reparse points stat cannot follow (EACCES), and files to CreateProcess.
        if (platform !== 'win32' || e.code !== 'EACCES') return false;
        try { return !fs.lstatSync(p).isDirectory(); } catch (_) { return false; }
      }
    }),
    isDir: deps.isDir || ((p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }),
    readFile: deps.readFile || ((p) => fs.readFileSync(p, 'utf8')),
    realpath: deps.realpath || ((p) => { try { return fs.realpathSync(p); } catch (_) { return p; } }),
    spawn: deps.spawn || require('child_process').spawn,
  };
}

/** Case-insensitive env lookup, since Windows spells Path, PATH or path. */
function _envVar(env, name) {
  if (env[name] != null) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/**
 * Find a program the way a shell would, without asking one.
 * @returns {string|null} absolute path, or null
 */
function which(bin, deps) {
  const d = _deps(deps);
  if (!bin || typeof bin !== 'string') return null;
  const p = d.pathApi;
  const exts = d.platform === 'win32'
    ? (_envVar(d.env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : [''];
  const withExts = (full) => (d.platform === 'win32' && p.extname(full) === '')
    ? exts.map((e) => full + e)
    : [full];

  if (p.isAbsolute(bin) || bin.includes('/') || (d.platform === 'win32' && bin.includes('\\'))) {
    return withExts(p.resolve(bin)).find((c) => d.isFile(c)) || null;
  }
  const dirs = String(_envVar(d.env, 'PATH') || '').split(d.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of withExts(p.join(dir.replace(/^"|"$/g, ''), bin))) {
      if (d.isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Split a command line typed in Settings into argv. Double and single quotes
 * group; backslashes are literal, so a Windows path needs no escaping.
 * @returns {string[]}
 */
function parseCommandLine(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of String(line || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
    }
  }
  if (started || cur) out.push(cur);
  return out;
}

// ── Windows locations ────────────────────────────────────────────────────────

function _winDirs(d) {
  const e = (n, fallback) => _envVar(d.env, n) || fallback;
  return {
    systemRoot: e('SystemRoot', 'C:\\Windows'),
    programFiles: e('ProgramFiles', 'C:\\Program Files'),
    programFilesX86: e('ProgramFiles(x86)', 'C:\\Program Files (x86)'),
    localAppData: e('LOCALAPPDATA', ''),
  };
}

/** Git for Windows' install folder: the usual places, then from git on PATH. */
function _gitForWindowsRoot(d) {
  const p = path.win32;
  const w = _winDirs(d);
  const roots = [
    p.join(w.programFiles, 'Git'),
    p.join(w.programFilesX86, 'Git'),
    w.localAppData ? p.join(w.localAppData, 'Programs', 'Git') : null,
  ].filter(Boolean);
  const git = which('git.exe', d);
  if (git) {
    // ...\Git\cmd\git.exe, ...\Git\bin\git.exe or ...\Git\mingw64\bin\git.exe
    const dir = p.dirname(git);
    roots.push(p.dirname(dir), p.dirname(p.dirname(dir)));
  }
  return roots.find((r) => d.isFile(p.join(r, 'bin', 'bash.exe'))) || null;
}

function _pwshPath(d) {
  const p = path.win32;
  const w = _winDirs(d);
  const fixed = [
    p.join(w.programFiles, 'PowerShell', '7', 'pwsh.exe'),
    p.join(w.programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
  ].find((c) => d.isFile(c));
  return fixed || which('pwsh.exe', d);
}

function _windowsTerminalPath(d) {
  const w = _winDirs(d);
  const alias = w.localAppData ? path.win32.join(w.localAppData, 'Microsoft', 'WindowsApps', 'wt.exe') : null;
  return (alias && d.isFile(alias)) ? alias : which('wt.exe', d);
}

// ── Shells for terminal tabs ─────────────────────────────────────────────────

const POSIX_SHELL_LABELS = {
  bash: 'Bash', zsh: 'Zsh', fish: 'fish', sh: 'sh', dash: 'dash', ksh: 'KornShell',
  mksh: 'MirBSD Korn Shell', tcsh: 'tcsh', csh: 'csh', nu: 'Nushell', pwsh: 'PowerShell',
  elvish: 'Elvish', xonsh: 'xonsh', oil: 'Oil', osh: 'Oil', ysh: 'YSH',
};

/** Entries of /etc/shells that are not interactive shells. */
const NOT_A_SHELL = new Set(['nologin', 'false', 'true', 'git-shell', 'rbash', 'screen', 'tmux']);

/**
 * The shells this machine has, for the Settings dropdown and for resolving
 * `terminalShell`. Ids are stable across machines (basename on POSIX, a fixed
 * name on Windows) so a synced setting finds the same shell elsewhere.
 * @returns {{ id: string, label: string, file: string, args: string[], env?: object }[]}
 */
function detectShells(deps) {
  const d = _deps(deps);
  const shells = [];
  if (d.platform === 'win32') {
    const p = path.win32;
    const w = _winDirs(d);
    const pwsh = _pwshPath(d);
    if (pwsh) shells.push({ id: 'pwsh', label: 'PowerShell 7', file: pwsh, args: ['-NoLogo'] });
    const cmd = p.join(w.systemRoot, 'System32', 'cmd.exe');
    shells.push({ id: 'cmd', label: 'Command Prompt', file: d.isFile(cmd) ? cmd : 'cmd.exe', args: [] });
    const gitRoot = _gitForWindowsRoot(d);
    if (gitRoot) {
      // --login reads the user's profile; CHERE_INVOKING keeps that profile
      // from moving to $HOME, so the tab opens in the project.
      shells.push({ id: 'git-bash', label: 'Git Bash', file: p.join(gitRoot, 'bin', 'bash.exe'), args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } });
    }
    const wsl = p.join(w.systemRoot, 'System32', 'wsl.exe');
    if (d.isFile(wsl)) shells.push({ id: 'wsl', label: 'WSL', file: wsl, args: [] });
    return shells;
  }

  let listed = [];
  try {
    listed = d.readFile('/etc/shells').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('/'));
  } catch (_) { /* no /etc/shells: only $SHELL and the usual suspects */ }
  const userShell = d.env.SHELL;
  const candidates = [...listed, userShell, '/bin/bash', '/bin/zsh', '/usr/bin/fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish'].filter(Boolean);
  const seenIds = new Set();
  const seenReal = new Set();
  for (const file of candidates) {
    const id = path.posix.basename(file);
    if (NOT_A_SHELL.has(id) || seenIds.has(id) || !d.isFile(file)) continue;
    const real = d.realpath(file);
    if (seenReal.has(real)) continue;
    seenIds.add(id);
    seenReal.add(real);
    shells.push({ id, label: `${POSIX_SHELL_LABELS[id] || id} (${file})`, file, args: [] });
  }
  return shells;
}

/** What a tab runs when `terminalShell` is empty. Mirrors TerminalService. */
function defaultShellLabel(deps) {
  const d = _deps(deps);
  return d.platform === 'win32' ? 'Windows PowerShell' : (d.env.SHELL || '/bin/bash');
}

/**
 * The program a plain shell tab runs, from the user's settings.
 *
 * `null` means "the historical default", which TerminalService keeps exactly
 * as it was. Otherwise `{ file, args, env, label }`, or `{ notice }` when the
 * chosen shell is not on this machine: the tab still opens on the default and
 * prints the notice, rather than failing to open.
 *
 * @param {{ terminalShell?: string, terminalShellCustomPath?: string, terminalShellCustomArgs?: string }} settings
 */
function resolveShell(settings, deps) {
  const id = typeof settings?.terminalShell === 'string' ? settings.terminalShell.trim() : '';
  if (!id) return null;
  const fallback = (what) => ({
    notice: `The shell "${what}" chosen in Settings is not available on this machine, so this tab runs ${defaultShellLabel(deps)}.`,
  });

  if (id === 'custom') {
    const raw = String(settings.terminalShellCustomPath || '').trim().replace(/^"(.*)"$/, '$1');
    if (!raw) return fallback('custom');
    const file = which(raw, deps);
    if (!file) return fallback(raw);
    return { file, args: parseCommandLine(settings.terminalShellCustomArgs), env: null, label: raw };
  }

  const shell = detectShells(deps).find((s) => s.id === id);
  if (!shell) return fallback(id);
  return { file: shell.file, args: shell.args.slice(), env: shell.env || null, label: shell.label };
}

// ── External terminals ───────────────────────────────────────────────────────

/**
 * One entry per terminal application this platform may have. `find` returns
 * the program to start, or null when it is not installed; `argv(dir, opts)`
 * returns what to run for a folder.
 */
function _externalCatalog(d) {
  if (d.platform === 'win32') {
    const w = _winDirs(d);
    const sys = (exe) => path.win32.join(w.systemRoot, 'System32', exe);
    return [
      { id: 'wt', label: 'Windows Terminal', supportsProfile: true,
        find: () => _windowsTerminalPath(d),
        argv: (file, dir, { profile }) => [file, '-d', _wtEscape(dir), ...(profile ? ['-p', _wtEscape(profile)] : [])] },
      { id: 'powershell', label: 'Windows PowerShell',
        find: () => (d.isFile(sys('WindowsPowerShell\\v1.0\\powershell.exe')) ? sys('WindowsPowerShell\\v1.0\\powershell.exe') : 'powershell.exe'),
        argv: (file) => [file, '-NoLogo'] },
      { id: 'pwsh', label: 'PowerShell 7', find: () => _pwshPath(d), argv: (file) => [file, '-NoLogo'] },
      { id: 'cmd', label: 'Command Prompt', find: () => (d.isFile(sys('cmd.exe')) ? sys('cmd.exe') : 'cmd.exe'), argv: (file) => [file] },
      { id: 'git-bash', label: 'Git Bash',
        find: () => { const r = _gitForWindowsRoot(d); const f = r && path.win32.join(r, 'git-bash.exe'); return f && d.isFile(f) ? f : null; },
        argv: (file, dir) => [file, `--cd=${dir}`] },
      { id: 'wsl', label: 'WSL', find: () => (d.isFile(sys('wsl.exe')) ? sys('wsl.exe') : null), argv: (file) => [file] },
    ];
  }

  if (d.platform === 'darwin') {
    const home = d.env.HOME || '';
    const bundle = (name) => [`/Applications/${name}.app`, `/System/Applications/Utilities/${name}.app`, `/Applications/Utilities/${name}.app`, home && `${home}/Applications/${name}.app`]
      .filter(Boolean).find((b) => d.isDir(b)) || null;
    // `open -a App dir` for the apps that open a folder they are handed;
    // `open -na App --args ...` for those that take the folder as a flag.
    const openDir = (app) => (file, dir) => ['/usr/bin/open', '-a', app, dir];
    const openArgs = (app, flags) => (file, dir) => ['/usr/bin/open', '-na', app, '--args', ...flags(dir)];
    return [
      { id: 'terminal', label: 'Terminal', find: () => bundle('Terminal') || '/System/Applications/Utilities/Terminal.app', argv: openDir('Terminal') },
      { id: 'iterm', label: 'iTerm2', find: () => bundle('iTerm'), argv: openDir('iTerm') },
      { id: 'warp', label: 'Warp', find: () => bundle('Warp'), argv: openDir('Warp') },
      { id: 'ghostty', label: 'Ghostty', find: () => bundle('Ghostty'), argv: openArgs('Ghostty', (dir) => [`--working-directory=${dir}`]) },
      { id: 'wezterm', label: 'WezTerm', find: () => bundle('WezTerm'), argv: openArgs('WezTerm', (dir) => ['start', '--cwd', dir]) },
      { id: 'kitty', label: 'kitty', find: () => bundle('kitty'), argv: openArgs('kitty', (dir) => ['--directory', dir]) },
      { id: 'alacritty', label: 'Alacritty', find: () => bundle('Alacritty'), argv: openArgs('Alacritty', (dir) => ['--working-directory', dir]) },
    ];
  }

  const onPath = (bin, flags) => ({ find: () => which(bin, d), argv: (file, dir) => [file, ...flags(dir)] });
  return [
    { id: 'x-terminal-emulator', label: 'System default (x-terminal-emulator)', ...onPath('x-terminal-emulator', () => []) },
    { id: 'gnome-terminal', label: 'GNOME Terminal', ...onPath('gnome-terminal', (dir) => [`--working-directory=${dir}`]) },
    { id: 'ptyxis', label: 'Ptyxis', ...onPath('ptyxis', (dir) => ['--new-window', `--working-directory=${dir}`]) },
    { id: 'kgx', label: 'GNOME Console', ...onPath('kgx', (dir) => [`--working-directory=${dir}`]) },
    { id: 'konsole', label: 'Konsole', ...onPath('konsole', (dir) => ['--workdir', dir]) },
    { id: 'xfce4-terminal', label: 'Xfce Terminal', ...onPath('xfce4-terminal', (dir) => [`--working-directory=${dir}`]) },
    { id: 'tilix', label: 'Tilix', ...onPath('tilix', (dir) => [`--working-directory=${dir}`]) },
    { id: 'terminator', label: 'Terminator', ...onPath('terminator', (dir) => [`--working-directory=${dir}`]) },
    { id: 'kitty', label: 'kitty', ...onPath('kitty', (dir) => ['--directory', dir]) },
    { id: 'alacritty', label: 'Alacritty', ...onPath('alacritty', (dir) => ['--working-directory', dir]) },
    { id: 'wezterm', label: 'WezTerm', ...onPath('wezterm', (dir) => ['start', '--cwd', dir]) },
    { id: 'foot', label: 'foot', ...onPath('foot', (dir) => [`--working-directory=${dir}`]) },
    { id: 'ghostty', label: 'Ghostty', ...onPath('ghostty', (dir) => [`--working-directory=${dir}`]) },
    { id: 'xterm', label: 'xterm', ...onPath('xterm', () => []) },
  ];
}

/** Windows Terminal splits its command line on `;` unless it is escaped. */
function _wtEscape(value) {
  return String(value).replace(/;/g, '\\;');
}

/**
 * Terminal applications installed here, in the order the dropdown lists them.
 * @returns {{ id: string, label: string, supportsProfile: boolean }[]}
 */
function detectExternalTerminals(deps) {
  const d = _deps(deps);
  return _externalCatalog(d)
    .filter((entry) => entry.find())
    .map(({ id, label, supportsProfile }) => ({ id, label, supportsProfile: !!supportsProfile }));
}

/** The id '' stands for on this machine: the first installed entry. */
function defaultExternalTerminalId(deps) {
  return detectExternalTerminals(deps)[0]?.id || null;
}

/**
 * Strip comments and trailing commas from JSONC, leaving strings alone.
 * Windows Terminal's settings.json is JSONC.
 */
function stripJsonc(text) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next || ''; i += 2; continue; }
      if (ch === '"') inString = false;
      i++;
    } else if (ch === '"') {
      inString = true; out += ch; i++;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += ch; i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Profile names from Windows Terminal's settings (stable, preview and the
 * unpackaged build), hidden ones left out. Never throws: no profiles is a
 * normal answer, the field stays free text.
 * @returns {string[]}
 */
function listWindowsTerminalProfiles(deps) {
  const d = _deps(deps);
  if (d.platform !== 'win32') return [];
  const { localAppData } = _winDirs(d);
  if (!localAppData) return [];
  const p = path.win32;
  const files = [
    p.join(localAppData, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    p.join(localAppData, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    p.join(localAppData, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];
  const names = [];
  for (const file of files) {
    let parsed;
    try { parsed = JSON.parse(stripJsonc(d.readFile(file))); } catch (_) { continue; }
    const list = Array.isArray(parsed?.profiles) ? parsed.profiles : parsed?.profiles?.list;
    if (!Array.isArray(list)) continue;
    for (const profile of list) {
      const name = typeof profile?.name === 'string' ? profile.name.trim() : '';
      if (name && profile.hidden !== true && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

// ── Launching ────────────────────────────────────────────────────────────────

/** Characters cmd.exe still interprets inside double quotes, plus line breaks. */
const CMD_UNSAFE = /["%\r\n\0]/;

/** One argument on a cmd.exe line read by a program with MSVCRT parsing. */
function _cmdQuote(arg) {
  // Backslashes before the closing quote would escape it: double them.
  return `"${String(arg).replace(/(\\+)$/, '$1$1')}"`;
}

/** A folder `start /D` and Windows Terminal's `-d` both read correctly. */
function _winDir(dir) {
  const normalized = path.win32.normalize(dir);
  // `E:\` would end on a backslash right before a quote.
  return /\\$/.test(normalized) ? `${normalized}.` : normalized;
}

/**
 * What to run to open `dir` in the configured terminal application.
 * @returns {{ argv: string[], label: string } | { error: string, code: string, name?: string }}
 */
function buildExternalLaunch(settings, dir, deps) {
  const d = _deps(deps);
  const chosen = typeof settings?.externalTerminal === 'string' ? settings.externalTerminal.trim() : '';
  const folder = d.platform === 'win32' ? _winDir(dir) : dir;

  if (chosen === 'custom') {
    const parts = parseCommandLine(settings.externalTerminalCustomCommand);
    if (!parts.length) return { code: 'NO_CUSTOM_COMMAND', error: 'No custom terminal command is set. Set one in Settings, General, External terminal.' };
    const file = which(parts[0], d);
    if (!file) return { code: 'NOT_FOUND', name: parts[0], error: `The terminal "${parts[0]}" set in Settings was not found on this machine.` };
    const args = parts.slice(1).map((a) => a.split('{path}').join(folder));
    return { argv: [file, ...args], label: parts[0] };
  }

  const catalog = _externalCatalog(d);
  const entry = chosen
    ? catalog.find((e) => e.id === chosen)
    : catalog.find((e) => e.find());
  if (!entry) {
    return chosen
      ? { code: 'NOT_FOUND', name: chosen, error: `The terminal "${chosen}" chosen in Settings is not available on this machine.` }
      : { code: 'NONE_FOUND', error: 'No terminal application was found on this machine. Choose a custom command in Settings, General, External terminal.' };
  }
  const file = entry.find();
  if (!file) return { code: 'NOT_FOUND', name: entry.label, error: `${entry.label} is not installed on this machine. Choose another terminal in Settings, General, External terminal.` };
  const profile = entry.supportsProfile ? String(settings?.externalTerminalProfile || '').trim() : '';
  return { argv: entry.argv(file, folder, { profile }), label: entry.label };
}

/**
 * Open a terminal application on a local folder. Resolves, never rejects.
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
function openExternalTerminal(dir, settings, deps) {
  const d = _deps(deps);
  if (typeof dir !== 'string' || !dir || !d.pathApi.isAbsolute(dir) || !d.isDir(dir)) {
    return Promise.resolve({ success: false, code: 'NOT_A_FOLDER', error: 'This folder does not exist on this machine.' });
  }
  const launch = buildExternalLaunch(settings, dir, d);
  if (launch.error) return Promise.resolve({ success: false, code: launch.code, name: launch.name, error: launch.error });

  let file;
  let args;
  let options;
  if (d.platform === 'win32') {
    const folder = _winDir(dir);
    if ([folder, ...launch.argv].some((a) => CMD_UNSAFE.test(a))) {
      return Promise.resolve({ success: false, code: 'UNSAFE_PATH', error: 'A path or argument containing " or % cannot be opened in an external terminal on Windows.' });
    }
    // `start` gives the program a console of its own (or hands it to the
    // default terminal application), outside the app's job object.
    const line = ['start', '""', '/D', _cmdQuote(folder), ...launch.argv.map(_cmdQuote)].join(' ');
    const cmd = path.win32.join(_winDirs(d).systemRoot, 'System32', 'cmd.exe');
    file = d.isFile(cmd) ? cmd : 'cmd.exe';
    args = ['/d', '/s', '/c', `"${line}"`];
    options = { cwd: dir, detached: true, stdio: 'ignore', windowsVerbatimArguments: true };
  } else {
    [file, ...args] = launch.argv;
    options = { cwd: dir, detached: true, stdio: 'ignore' };
  }

  // `open` and cmd's `start` hand over and exit at once, so their exit code
  // says whether the launch worked; anything else is running once it spawned.
  const waitsForExit = d.platform === 'win32' || file === '/usr/bin/open';
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    let child;
    try {
      child = d.spawn(file, args, options);
    } catch (error) {
      done({ success: false, code: 'LAUNCH_FAILED', name: launch.label, error: `Could not start ${launch.label}: ${error.message}` });
      return;
    }
    child.on('error', (error) => done({ success: false, code: 'LAUNCH_FAILED', name: launch.label, error: `Could not start ${launch.label}: ${error.message}` }));
    if (waitsForExit) {
      child.on('exit', (code) => done(code === 0
        ? { success: true }
        : { success: false, code: 'LAUNCH_FAILED', name: launch.label, error: `${launch.label} did not start (exit code ${code}).` }));
      // A launcher that hangs is still a launch: do not hold the caller.
      setTimeout(() => done({ success: true }), 5000).unref?.();
    } else {
      child.on('spawn', () => done({ success: true }));
    }
    if (typeof child.unref === 'function') child.unref();
  });
}

module.exports = {
  which,
  parseCommandLine,
  detectShells,
  defaultShellLabel,
  resolveShell,
  detectExternalTerminals,
  defaultExternalTerminalId,
  listWindowsTerminalProfiles,
  stripJsonc,
  buildExternalLaunch,
  openExternalTerminal,
};
