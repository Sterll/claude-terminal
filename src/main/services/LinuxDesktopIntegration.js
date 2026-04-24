/**
 * Linux Desktop Integration
 *
 * Registers/updates a XDG `.desktop` file and icon so that the app appears in
 * the application menu after the user launches the AppImage for the first time,
 * and so subsequent updates (AppImages with a different filename) keep working.
 *
 * Without this, AppImages distributed without AppImageLauncher are invisible
 * to GNOME/KDE/etc. until the user manually creates a `.desktop` entry —
 * and any such entry breaks on every release because the versioned filename
 * changes (e.g. Claude-Terminal-1.2.6.AppImage -> Claude-Terminal-1.2.7.AppImage).
 *
 * Strategy:
 *   - Run on every launch, only when `process.platform === 'linux'` and
 *     `process.env.APPIMAGE` is set (electron-builder injects it).
 *   - Write to ~/.local/share/applications/claude-terminal.desktop, pointing
 *     `Exec=` and `TryExec=` at the current AppImage path.
 *   - Copy the bundled icon to ~/.local/share/icons/claude-terminal.png and
 *     reference it by absolute path (works across every DE without relying
 *     on the hicolor theme cache being regenerated).
 *   - Mark the file with `X-Claude-Terminal-ManagedBy=app` so we never stomp
 *     on a file the user maintains by hand.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const APP_NAME = 'Claude Terminal';
const DESKTOP_FILE_NAME = 'claude-terminal.desktop';
const ICON_FILE_NAME = 'claude-terminal.png';
const MANAGED_MARKER = 'X-Claude-Terminal-ManagedBy=app';

/**
 * Build the full contents of the `.desktop` file.
 * Pure function — easy to unit test.
 *
 * @param {object} opts
 * @param {string} opts.appImagePath  Absolute path to the current AppImage.
 * @param {string} opts.iconPath      Absolute path to the installed icon.
 * @param {string} [opts.version]     App version (for X-AppImage-Version).
 * @returns {string}
 */
function buildDesktopFileContent({ appImagePath, iconPath, version }) {
  // Quote the AppImage path so it survives spaces in the filename.
  const quotedExec = '"' + appImagePath.replace(/"/g, '\\"') + '"';

  const lines = [
    '[Desktop Entry]',
    `Name=${APP_NAME}`,
    'Comment=Terminal for Claude Code projects',
    // --no-sandbox: required for AppImages — Chromium's SUID sandbox needs
    // permissions that AppImage environments cannot provide.
    `Exec=${quotedExec} --no-sandbox %U`,
    `TryExec=${appImagePath}`,
    `Icon=${iconPath}`,
    'Terminal=false',
    'Type=Application',
    'Categories=Development;Utility;',
    'StartupWMClass=claude-terminal',
  ];
  if (version) {
    lines.push(`X-AppImage-Version=${version}`);
  }
  lines.push(MANAGED_MARKER);
  lines.push('');
  return lines.join('\n');
}

/**
 * Decide whether the existing `.desktop` should be rewritten.
 * Pure function — easy to unit test.
 *
 * Rules:
 *   - No existing file      -> write.
 *   - Managed by us & stale -> write.
 *   - User-maintained       -> leave it alone.
 *
 * @param {string|null} existingContent
 * @param {string}      newContent
 * @returns {boolean}
 */
function shouldWriteDesktopFile(existingContent, newContent) {
  if (!existingContent) return true;
  if (!existingContent.includes(MANAGED_MARKER)) return false;
  return existingContent !== newContent;
}

/**
 * Resolve the bundled icon source path.
 * In development it sits under `<repo>/assets/icon.png`; inside a packaged
 * AppImage it may live under `process.resourcesPath` (when included via
 * `extraResources`) or inside the asar archive.
 *
 * @param {string} [resourcesPath]
 * @returns {string|null}
 */
function resolveBundledIconPath(resourcesPath) {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'assets', 'icon.png'),
  ];
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'assets', 'icon.png'));
    candidates.push(path.join(resourcesPath, 'app.asar.unpacked', 'assets', 'icon.png'));
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { /* keep trying */ }
  }
  return null;
}

/**
 * Perform the actual installation (public for tests — callers should use {@link run}).
 *
 * @param {object} opts
 * @param {string}        opts.home             Home directory.
 * @param {string}        opts.appImagePath     Current AppImage path.
 * @param {string|null}   opts.iconSourcePath   Bundled icon source (may be null).
 * @param {string}        [opts.version]        App version string.
 * @param {object}        [opts.logger]         Console-like logger.
 * @param {object}        [opts.fsImpl]         Injected fs (for tests).
 * @param {Function}      [opts.refreshFn]      Invoked to refresh desktop DB.
 * @returns {{written: boolean, desktopPath: string, iconPath: string|null, skipped?: string}}
 */
function install({ home, appImagePath, iconSourcePath, version, logger, fsImpl, refreshFn }) {
  const _fs = fsImpl || fs;
  const applicationsDir = path.join(home, '.local', 'share', 'applications');
  const iconDir = path.join(home, '.local', 'share', 'icons');
  const desktopPath = path.join(applicationsDir, DESKTOP_FILE_NAME);
  const iconPath = path.join(iconDir, ICON_FILE_NAME);

  _fs.mkdirSync(applicationsDir, { recursive: true });
  _fs.mkdirSync(iconDir, { recursive: true });

  let installedIconPath = null;
  if (iconSourcePath) {
    try {
      const needsIcon =
        !_fs.existsSync(iconPath) ||
        _fs.statSync(iconPath).mtimeMs < _fs.statSync(iconSourcePath).mtimeMs;
      if (needsIcon) {
        _fs.copyFileSync(iconSourcePath, iconPath);
      }
      installedIconPath = iconPath;
    } catch (e) {
      logger && logger.warn && logger.warn('[LinuxDesktopIntegration] icon install failed:', e.message);
    }
  }

  // If the icon copy failed AND no prior icon exists, fall back to the
  // AppImage-internal `claude-terminal` name — many themes resolve it.
  const iconToReference = installedIconPath || 'claude-terminal';

  const newContent = buildDesktopFileContent({ appImagePath, iconPath: iconToReference, version });

  let existing = null;
  try { existing = _fs.readFileSync(desktopPath, 'utf8'); } catch (_) { /* missing is fine */ }

  if (!shouldWriteDesktopFile(existing, newContent)) {
    return { written: false, desktopPath, iconPath: installedIconPath, skipped: existing ? 'up-to-date-or-user-managed' : 'unknown' };
  }

  _fs.writeFileSync(desktopPath, newContent);
  try { _fs.chmodSync(desktopPath, 0o755); } catch (_) { /* best-effort */ }

  if (refreshFn) {
    try { refreshFn(applicationsDir); } catch (_) { /* best-effort */ }
  }

  return { written: true, desktopPath, iconPath: installedIconPath };
}

/**
 * Run the integration. Safe to call unconditionally — bails out cleanly on
 * non-Linux platforms, non-AppImage launches, and any I/O error.
 *
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @returns {{written?: boolean, skipped?: string, error?: string}}
 */
function run(opts = {}) {
  const logger = opts.logger || console;

  if (process.platform !== 'linux') return { skipped: 'not-linux' };

  const appImagePath = process.env.APPIMAGE;
  if (!appImagePath) return { skipped: 'not-appimage' };

  try {
    const home = os.homedir();
    const resourcesPath = process.resourcesPath;
    const iconSourcePath = resolveBundledIconPath(resourcesPath);

    let version = '';
    try {
      // eslint-disable-next-line global-require
      version = require(path.join(__dirname, '..', '..', '..', 'package.json')).version || '';
    } catch (_) { /* ignore */ }

    const result = install({
      home,
      appImagePath,
      iconSourcePath,
      version,
      logger,
      refreshFn: refreshDesktopDatabase,
    });

    if (result.written) {
      logger.log && logger.log(`[LinuxDesktopIntegration] updated ${result.desktopPath} -> ${appImagePath}`);
    }
    return result;
  } catch (e) {
    logger.warn && logger.warn('[LinuxDesktopIntegration] failed:', e.message);
    return { error: e.message };
  }
}

/**
 * Best-effort, non-blocking refresh of the desktop entry database.
 * Missing binary, non-zero exit, or timeout are all silently ignored.
 */
function refreshDesktopDatabase(applicationsDir) {
  execFile('update-desktop-database', [applicationsDir], { timeout: 5000 }, () => { /* ignore */ });
}

module.exports = {
  run,
  install,
  buildDesktopFileContent,
  shouldWriteDesktopFile,
  resolveBundledIconPath,
  // Exported constants for tests.
  _internals: { APP_NAME, DESKTOP_FILE_NAME, ICON_FILE_NAME, MANAGED_MARKER },
};
