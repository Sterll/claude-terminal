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

  test('escapes the characters the Exec spec reserves inside quotes', () => {
    expect(quoteExecArg('/a "b" $c')).toBe('"/a \\"b\\" \\$c"');
  });

  test('replaces its own entry and a hand-made npm start one, nothing else', () => {
    expect(mayReplace(null)).toBe(true);
    expect(mayReplace(entry)).toBe(true);
    expect(mayReplace('[Desktop Entry]\nName=Claude Terminal\nExec=/usr/bin/npm start --prefix /x\n')).toBe(true);
    expect(mayReplace('[Desktop Entry]\nName=Claude Terminal\nExec="/a/Claude.AppImage" --no-sandbox %U\nX-Claude-Terminal-ManagedBy=app\n')).toBe(false);
    expect(mayReplace('[Desktop Entry]\nName=My Claude\nExec=/usr/bin/npm start\n')).toBe(false);
  });
});
