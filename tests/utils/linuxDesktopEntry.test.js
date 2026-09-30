const { buildDesktopEntry, mayReplace, quoteExecArg, MARKER } = require('../../scripts/linux-desktop-entry.cjs');

describe('linux-desktop-entry', () => {
  const entry = buildDesktopEntry({
    nodePath: '/home/u/.nvm/versions/node/v22/bin/node',
    launcherPath: '/home/u/src/claude terminal/scripts/linux-launch.cjs',
    iconPath: '/home/u/.local/share/icons/hicolor/512x512/apps/claude-terminal.png',
  });

  test('runs the launcher with an absolute node, never npm from PATH', () => {
    expect(entry).toContain('Exec="/home/u/.nvm/versions/node/v22/bin/node" "/home/u/src/claude terminal/scripts/linux-launch.cjs" %U');
    expect(entry).not.toMatch(/\bnpm\b/);
  });

  test('carries an icon, the window class and its marker', () => {
    expect(entry).toContain('Icon=/home/u/.local/share/icons/hicolor/512x512/apps/claude-terminal.png');
    expect(entry).toContain('StartupWMClass=claude-terminal');
    expect(entry).toContain(MARKER);
  });

  test('escapes for the Exec quoting rules and for the string value under them', () => {
    // On disk each quoting backslash is doubled, since the string-value pass
    // runs first: `\"` alone is an invalid escape and GLib drops the key.
    expect(quoteExecArg('/a "b" $c')).toBe('"/a \\\\"b\\\\" \\\\$c"');
    // A literal backslash takes four.
    expect(quoteExecArg('/a\\b')).toBe('"/a\\\\\\\\b"');
  });

  test('doubles a percent sign so it is not read as a field code', () => {
    expect(quoteExecArg('/home/u/100%/node')).toBe('"/home/u/100%%/node"');
  });

  test('replaces its own entry and a hand-made npm start one for this checkout, nothing else', () => {
    const root = '/x';
    expect(mayReplace(null, root)).toBe(true);
    expect(mayReplace(entry, root)).toBe(true);
    expect(mayReplace('[Desktop Entry]\nName=Claude Terminal\nExec=/usr/bin/npm start --prefix /x\n', root)).toBe(true);
    expect(mayReplace('[Desktop Entry]\nName=Claude Terminal\nExec=npm start\nPath=/x\n', root)).toBe(true);
    expect(mayReplace('[Desktop Entry]\nName=Claude Terminal\nExec=/usr/bin/npm start --prefix /other\n', root)).toBe(false);
    expect(mayReplace('[Desktop Entry]\nName=Claude Terminal\nExec="/a/Claude.AppImage" --no-sandbox %U\nX-Claude-Terminal-ManagedBy=app\n', root)).toBe(false);
    expect(mayReplace('[Desktop Entry]\nName=My Claude\nExec=/usr/bin/npm start --prefix /x\n', root)).toBe(false);
  });
});
