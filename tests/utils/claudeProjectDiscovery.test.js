/**
 * The folders Claude Code was already used in, for the first-launch import.
 * The transcript directory name is lossy, so the path must come from the
 * `cwd` the CLI writes on its lines, and only folders worth a project are
 * offered.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { discoverClaudeProjectFolders, readTranscriptCwd } = require('../../src/main/utils/claudeProjectDiscovery');
const { encodeProjectPath } = require('../../src/shared/session-dirs');

let home;
let tmpDir;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-discover-home-'));
  // Treated as the system temp folder; the fixture home itself lives under
  // the real one, so the real one cannot be used here.
  tmpDir = path.join(home, 'system-temp');
  fs.mkdirSync(tmpDir);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A transcript filed under `dirFor` (default: cwd's own encoding), ending at `when`. */
function writeTranscript(cwd, { when = '2026-11-01T10:00:00.000Z', dirFor = cwd, name = 's1', padding = 0, lines = null } = {}) {
  const dir = path.join(home, '.claude', 'projects', encodeProjectPath(dirFor));
  fs.mkdirSync(dir, { recursive: true });
  const body = lines || [
    JSON.stringify({ type: 'summary', summary: 'x' }),
    JSON.stringify({ type: 'user', cwd, sessionId: name, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } }),
    ...Array.from({ length: padding }, (_, i) => JSON.stringify({ type: 'file-history-snapshot', n: i, blob: 'y'.repeat(200) })),
    JSON.stringify({ type: 'assistant', cwd, sessionId: name, timestamp: when, message: { role: 'assistant', content: [] } }),
  ];
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, body.join('\n') + '\n');
  return file;
}

function folder(...parts) {
  const p = path.join(home, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const discover = (opts = {}) => discoverClaudeProjectFolders({ home, tmpDir, ...opts });

describe('discoverClaudeProjectFolders', () => {
  test('no ~/.claude/projects at all is an empty list, not an error', async () => {
    await expect(discover()).resolves.toEqual([]);
  });

  test('reads the real path from cwd, even where the directory name is ambiguous', async () => {
    // "my-app" and "my/app" encode to the same directory name: only cwd tells.
    const real = folder('work', 'my-app');
    folder('work', 'my', 'app');
    writeTranscript(real);

    const found = await discover();
    expect(found).toEqual([
      expect.objectContaining({ path: real, name: 'my-app', sessionCount: 1 }),
    ]);
  });

  test('sorted by last activity, taken from the last message line', async () => {
    const older = folder('older');
    const newer = folder('newer');
    writeTranscript(older, { when: '2026-03-01T00:00:00.000Z' });
    writeTranscript(newer, { when: '2026-10-01T00:00:00.000Z' });

    const found = await discover();
    expect(found.map(f => f.path)).toEqual([newer, older]);
    expect(found[0].lastActivity).toBe(Date.parse('2026-10-01T00:00:00.000Z'));
  });

  test('leaves out folders that are gone, the home folder, temp, app data and worktrees', async () => {
    const kept = folder('kept');
    writeTranscript(kept);
    writeTranscript(path.join(home, 'deleted-since'));
    writeTranscript(home);
    writeTranscript(folder('system-temp', 'scratch'));
    writeTranscript(folder('.claude-terminal', 'worktrees', 'run-1', 'task'));
    writeTranscript(folder('kept', '.claude', 'worktrees', 'feature'));
    // A linked worktree made with `git worktree add`, anywhere.
    const linked = folder('linked-wt');
    fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${path.join(kept, '.git', 'worktrees', 'linked-wt')}\n`);
    writeTranscript(linked);
    // A submodule also has a .git file, and is a real folder to work in.
    const submodule = folder('kept', 'vendor', 'lib');
    fs.writeFileSync(path.join(submodule, '.git'), `gitdir: ${path.join(kept, '.git', 'modules', 'lib')}\n`);
    writeTranscript(submodule, { when: '2026-01-01T00:00:00.000Z' });

    const found = await discover();
    expect(found.map(f => f.path).sort()).toEqual([kept, submodule].sort());
  });

  test('leaves out the folder the app is installed in', async () => {
    const install = folder('Programs', 'Claude Terminal');
    writeTranscript(install);
    const kept = folder('kept');
    writeTranscript(kept);
    const found = await discover({ appInstallDir: install });
    expect(found.map(f => f.path)).toEqual([kept]);
  });

  test('leaves out paths that are already projects, whatever their case and slashes', async () => {
    const a = folder('a');
    const b = folder('b');
    writeTranscript(a);
    writeTranscript(b);
    const already = process.platform === 'win32' ? a.toUpperCase().replace(/\\/g, '/') + '/' : a;

    const found = await discover({ exclude: [already] });
    expect(found.map(f => f.path)).toEqual([b]);
  });

  test('a transcript whose tail has no cwd falls back to its head', async () => {
    const p = folder('long');
    // The tail is 64 KB of lines without cwd; the head has it.
    const file = writeTranscript(p, {
      lines: [
        JSON.stringify({ type: 'user', cwd: p, timestamp: '2026-05-01T00:00:00.000Z', message: { content: 'hi' } }),
        ...Array.from({ length: 600 }, () => JSON.stringify({ type: 'file-history-snapshot', blob: 'z'.repeat(200) })),
      ],
    });
    expect(fs.statSync(file).size).toBeGreaterThan(64 * 1024);
    const { cwd } = await readTranscriptCwd(file, fs.statSync(file).size);
    expect(cwd).toBe(p);
  });

  test('a session that moved into another folder is counted where it is filed now', async () => {
    // The CLI re-files a transcript under its current cwd, so the tail wins
    // over the cwd the session started in.
    const start = folder('start');
    const now = folder('now');
    writeTranscript(now, {
      lines: [
        JSON.stringify({ type: 'user', cwd: start, timestamp: '2026-05-01T00:00:00.000Z' }),
        JSON.stringify({ type: 'assistant', cwd: now, timestamp: '2026-05-02T00:00:00.000Z' }),
      ],
    });
    const found = await discover();
    expect(found.map(f => f.path)).toEqual([now]);
  });

  test('reads only the newest few transcripts of a directory, and counts them all', async () => {
    const p = folder('busy');
    for (let i = 0; i < 6; i++) writeTranscript(p, { name: `s${i}` });
    const found = await discover();
    expect(found).toEqual([expect.objectContaining({ path: p, sessionCount: 6 })]);
  });

  test('a directory with no readable cwd is skipped, not fatal', async () => {
    const dir = path.join(home, '.claude', 'projects', 'C--garbage');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.jsonl'), 'not json\n{"type":"summary"}\n');
    const ok = folder('ok');
    writeTranscript(ok);
    const found = await discover();
    expect(found.map(f => f.path)).toEqual([ok]);
  });
});
