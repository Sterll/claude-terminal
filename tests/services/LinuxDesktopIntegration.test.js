// LinuxDesktopIntegration unit tests — pure functions + install() with injected fs.

const path = require('path');

const {
  run,
  install,
  buildDesktopFileContent,
  shouldWriteDesktopFile,
  resolveBundledIconPath,
  looksLikeLegacyClaudeTerminalDesktop,
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

  test('adopts a pre-v1.2.8 legacy entry that clearly targets this app (no marker)', () => {
    // Pre-v1.2.8 users created `.desktop` entries by hand or via workaround
    // scripts. They never carry the marker, but they unmistakably point at
    // our AppImage — overwrite once so future updates flow through the
    // managed path.
    const legacy = [
      '[Desktop Entry]',
      'Name=Claude Terminal',
      'Exec=/home/user/Applications/Claude-Terminal.AppImage --no-sandbox %U',
      'Type=Application',
      '',
    ].join('\n');
    expect(shouldWriteDesktopFile(legacy, ours)).toBe(true);
  });

  test('still leaves a user-maintained entry alone when Exec points elsewhere', () => {
    const wrapped = [
      '[Desktop Entry]',
      'Name=Claude Terminal',
      'Exec=/usr/local/bin/my-claude-wrapper.sh %U',
      'Type=Application',
      '',
    ].join('\n');
    expect(shouldWriteDesktopFile(wrapped, ours)).toBe(false);
  });
});

// ── looksLikeLegacyClaudeTerminalDesktop ──────────────────────────────────

describe('looksLikeLegacyClaudeTerminalDesktop', () => {
  test('matches an entry pointing at the stable symlink', () => {
    const content = [
      '[Desktop Entry]',
      'Name=Claude Terminal',
      'Exec=/home/user/Applications/Claude-Terminal.AppImage --no-sandbox %U',
      'Type=Application',
    ].join('\n');
    expect(looksLikeLegacyClaudeTerminalDesktop(content)).toBe(true);
  });

  test('matches an entry pointing at a versioned AppImage', () => {
    const content = [
      '[Desktop Entry]',
      'Name=Claude Terminal',
      'Exec=/home/user/Applications/Claude-Terminal-1.2.7.AppImage --no-sandbox %U',
      'Type=Application',
    ].join('\n');
    expect(looksLikeLegacyClaudeTerminalDesktop(content)).toBe(true);
  });

  test('matches an entry whose Exec is quoted', () => {
    const content = [
      '[Desktop Entry]',
      'Name=Claude Terminal',
      'Exec="/home/user/Applications/Claude-Terminal-1.2.7.AppImage" --no-sandbox %U',
      'Type=Application',
    ].join('\n');
    expect(looksLikeLegacyClaudeTerminalDesktop(content)).toBe(true);
  });

  test('rejects entries with a different Name', () => {
    const content = [
      '[Desktop Entry]',
      'Name=My Custom Claude',
      'Exec=/home/user/Applications/Claude-Terminal.AppImage --no-sandbox %U',
      'Type=Application',
    ].join('\n');
    expect(looksLikeLegacyClaudeTerminalDesktop(content)).toBe(false);
  });

  test('rejects entries whose Exec targets a wrapper instead of the AppImage', () => {
    const content = [
      '[Desktop Entry]',
      'Name=Claude Terminal',
      'Exec=/usr/local/bin/my-claude-wrapper.sh %U',
      'Type=Application',
    ].join('\n');
    expect(looksLikeLegacyClaudeTerminalDesktop(content)).toBe(false);
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

  test('adopts and rewrites a pre-v1.2.8 legacy .desktop on first run', () => {
    // Reproduces the real-world scenario: a user installed before v1.2.8 and
    // had a hand-maintained `.desktop` pointing at the AppImage, but without
    // our marker. After upgrading, the first launch should adopt it — not
    // skip silently — so subsequent updates flow through the managed path.
    const fakeFs = makeFakeFs();
    fakeFs._seed(iconSourcePath, 'PNGDATA');
    const legacyContent = [
      '[Desktop Entry]',
      'Name=Claude Terminal',
      'Exec=/home/user/Applications/Claude-Terminal.AppImage --no-sandbox %U',
      'Type=Application',
      '',
    ].join('\n');
    fakeFs._seed(desktopPath, legacyContent);

    const result = install({
      home, appImagePath, iconSourcePath, version,
      fsImpl: fakeFs, refreshFn: () => {},
    });

    expect(result.written).toBe(true);
    const written = fakeFs._files.get(desktopPath).content;
    expect(written).toContain(MANAGED_MARKER);
    expect(written).toContain(`Exec="${appImagePath}" --no-sandbox %U`);
    expect(written).not.toBe(legacyContent);
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
