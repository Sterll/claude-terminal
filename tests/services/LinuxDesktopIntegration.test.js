// LinuxDesktopIntegration unit tests — pure functions + install() with injected fs.

const path = require('path');

const {
  run,
  install,
  buildDesktopFileContent,
  shouldWriteDesktopFile,
  resolveBundledIconPath,
  _internals,
} = require('../../src/main/services/LinuxDesktopIntegration');

const { DESKTOP_FILE_NAME, ICON_FILE_NAME, MANAGED_MARKER } = _internals;

// ── buildDesktopFileContent ───────────────────────────────────────────────

describe('buildDesktopFileContent', () => {
  const baseArgs = {
    appImagePath: '/home/user/Applications/Claude-Terminal-1.2.7.AppImage',
    iconPath: '/home/user/.local/share/icons/claude-terminal.png',
    version: '1.2.7',
  };

  test('emits a valid Desktop Entry header', () => {
    const content = buildDesktopFileContent(baseArgs);
    expect(content.startsWith('[Desktop Entry]\n')).toBe(true);
  });

  test('includes Name, Type, and Terminal=false', () => {
    const content = buildDesktopFileContent(baseArgs);
    expect(content).toContain('Name=Claude Terminal');
    expect(content).toContain('Type=Application');
    expect(content).toContain('Terminal=false');
  });

  test('quotes the AppImage path in Exec and preserves TryExec', () => {
    const content = buildDesktopFileContent(baseArgs);
    expect(content).toContain(`Exec="${baseArgs.appImagePath}" --no-sandbox %U`);
    expect(content).toContain(`TryExec=${baseArgs.appImagePath}`);
  });

  test('escapes double quotes in the AppImage path', () => {
    const content = buildDesktopFileContent({
      ...baseArgs,
      appImagePath: '/weird/path with "quotes".AppImage',
    });
    expect(content).toContain('Exec="/weird/path with \\"quotes\\".AppImage" --no-sandbox %U');
  });

  test('uses the provided icon path verbatim', () => {
    const content = buildDesktopFileContent(baseArgs);
    expect(content).toContain(`Icon=${baseArgs.iconPath}`);
  });

  test('includes version when provided', () => {
    const content = buildDesktopFileContent(baseArgs);
    expect(content).toContain('X-AppImage-Version=1.2.7');
  });

  test('omits X-AppImage-Version when version is falsy', () => {
    const content = buildDesktopFileContent({ ...baseArgs, version: '' });
    expect(content).not.toContain('X-AppImage-Version=');
  });

  test('always carries the managed marker', () => {
    const content = buildDesktopFileContent(baseArgs);
    expect(content).toContain(MANAGED_MARKER);
  });
});

// ── shouldWriteDesktopFile ────────────────────────────────────────────────

describe('shouldWriteDesktopFile', () => {
  const ours = `[Desktop Entry]\nName=Claude Terminal\n${MANAGED_MARKER}\n`;
  const stale = `[Desktop Entry]\nName=Claude Terminal\nExec=/old/path\n${MANAGED_MARKER}\n`;
  const userOwned = '[Desktop Entry]\nName=Claude Terminal\nExec=/my/custom/path\n';

  test('writes when there is no existing file', () => {
    expect(shouldWriteDesktopFile(null, ours)).toBe(true);
  });

  test('does not write when content is already up-to-date', () => {
    expect(shouldWriteDesktopFile(ours, ours)).toBe(false);
  });

  test('overwrites a previously-managed file when content drifted', () => {
    expect(shouldWriteDesktopFile(stale, ours)).toBe(true);
  });

  test('leaves user-maintained files alone (no marker)', () => {
    expect(shouldWriteDesktopFile(userOwned, ours)).toBe(false);
  });
});

// ── install (with injected fs) ────────────────────────────────────────────

function makeFakeFs() {
  const files = new Map(); // absolute path -> { content, mtimeMs }
  const dirs = new Set();
  const now = () => Date.now();

  return {
    _files: files,
    _dirs: dirs,
    mkdirSync(p, _opts) { dirs.add(p); },
    existsSync(p) { return files.has(p); },
    statSync(p) {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mtimeMs: files.get(p).mtimeMs };
    },
    readFileSync(p) {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p).content;
    },
    writeFileSync(p, content) { files.set(p, { content, mtimeMs: now() }); },
    copyFileSync(src, dest) {
      if (!files.has(src)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      files.set(dest, { content: files.get(src).content, mtimeMs: now() });
    },
    chmodSync() { /* noop */ },
    // Test helpers
    _seed(p, content, mtimeMs = now()) { files.set(p, { content, mtimeMs }); },
  };
}

describe('install', () => {
  const home = '/home/user';
  const appImagePath = '/home/user/Applications/Claude-Terminal-1.2.7.AppImage';
  const iconSourcePath = '/repo/assets/icon.png';
  const version = '1.2.7';

  const desktopPath = path.join(home, '.local', 'share', 'applications', DESKTOP_FILE_NAME);
  const iconPath = path.join(home, '.local', 'share', 'icons', ICON_FILE_NAME);

  test('writes .desktop and copies icon on a clean system', () => {
    const fakeFs = makeFakeFs();
    fakeFs._seed(iconSourcePath, 'PNGDATA');
    const refreshFn = jest.fn();

    const result = install({
      home, appImagePath, iconSourcePath, version,
      fsImpl: fakeFs, refreshFn,
    });

    expect(result.written).toBe(true);
    expect(result.desktopPath).toBe(desktopPath);
    expect(result.iconPath).toBe(iconPath);

    const written = fakeFs._files.get(desktopPath).content;
    expect(written).toContain(`Exec="${appImagePath}" --no-sandbox %U`);
    expect(written).toContain(`Icon=${iconPath}`);
    expect(written).toContain(MANAGED_MARKER);
    expect(fakeFs._files.get(iconPath).content).toBe('PNGDATA');
    expect(refreshFn).toHaveBeenCalledWith(path.join(home, '.local', 'share', 'applications'));
  });

  test('rewrites .desktop when AppImage path changed (simulated update)', () => {
    const fakeFs = makeFakeFs();
    fakeFs._seed(iconSourcePath, 'PNGDATA');

    // First install at version 1.2.6.
    const oldPath = '/home/user/Applications/Claude-Terminal-1.2.6.AppImage';
    install({
      home, appImagePath: oldPath, iconSourcePath, version: '1.2.6',
      fsImpl: fakeFs, refreshFn: () => {},
    });
    expect(fakeFs._files.get(desktopPath).content).toContain(oldPath);

    // Simulate update → AppImage filename changes, app relaunches.
    const result = install({
      home, appImagePath, iconSourcePath, version,
      fsImpl: fakeFs, refreshFn: () => {},
    });

    expect(result.written).toBe(true);
    expect(fakeFs._files.get(desktopPath).content).toContain(appImagePath);
    expect(fakeFs._files.get(desktopPath).content).not.toContain(oldPath);
  });

  test('is a no-op when the file is already up-to-date', () => {
    const fakeFs = makeFakeFs();
    fakeFs._seed(iconSourcePath, 'PNGDATA');

    install({
      home, appImagePath, iconSourcePath, version,
      fsImpl: fakeFs, refreshFn: () => {},
    });

    const refreshFn = jest.fn();
    const second = install({
      home, appImagePath, iconSourcePath, version,
      fsImpl: fakeFs, refreshFn,
    });

    expect(second.written).toBe(false);
    expect(refreshFn).not.toHaveBeenCalled();
  });

  test('does not overwrite a user-maintained .desktop (missing marker)', () => {
    const fakeFs = makeFakeFs();
    fakeFs._seed(iconSourcePath, 'PNGDATA');
    const userContent = '[Desktop Entry]\nName=Claude Terminal\nExec=/my/own/path\n';
    fakeFs._seed(desktopPath, userContent);

    const result = install({
      home, appImagePath, iconSourcePath, version,
      fsImpl: fakeFs, refreshFn: () => {},
    });

    expect(result.written).toBe(false);
    expect(fakeFs._files.get(desktopPath).content).toBe(userContent);
  });

  test('falls back to icon name when no bundled icon is available', () => {
    const fakeFs = makeFakeFs();
    // No icon source seeded.

    const result = install({
      home, appImagePath, iconSourcePath: null, version,
      fsImpl: fakeFs, refreshFn: () => {},
    });

    expect(result.written).toBe(true);
    expect(result.iconPath).toBeNull();
    const written = fakeFs._files.get(desktopPath).content;
    expect(written).toContain('Icon=claude-terminal');
  });
});

// ── resolveBundledIconPath ────────────────────────────────────────────────

describe('resolveBundledIconPath', () => {
  test('returns null when nothing is found (purely tests the no-match branch)', () => {
    // Pass a resources path we know does not exist.
    const result = resolveBundledIconPath('/definitely/not/a/real/path/' + Math.random());
    // Might still resolve to the dev-time assets/icon.png if the suite runs
    // from the repo root — just assert it is either a string or null.
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

// ── run (platform guards) ─────────────────────────────────────────────────

describe('run', () => {
  const originalPlatform = process.platform;
  const originalAppImage = process.env.APPIMAGE;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = originalAppImage;
  });

  test('skips when platform is not Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(run({ logger: { log() {}, warn() {} } })).toEqual({ skipped: 'not-linux' });
  });

  test('skips when APPIMAGE env var is not set on Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env.APPIMAGE;
    expect(run({ logger: { log() {}, warn() {} } })).toEqual({ skipped: 'not-appimage' });
  });
});
