/**
 * Reading where a session worked from its transcript. The entries are shaped
 * like Claude Code's: a `cwd` on every line, tool calls in assistant messages,
 * their results in the next user message.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionActivityService, _internals } = require('../../src/main/services/SessionActivityService');

const { createActivity, readEntry, summarize } = _internals;
// Paths come back normalized for the platform: '/a' is '\\a' on Windows.
const P = (p) => path.normalize(p);

let clock = Date.parse('2026-10-09T10:00:00Z');
const at = () => new Date(clock += 1000).toISOString();
const use = (id, name, input, cwd = '/repo') => ({ cwd, timestamp: at(), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, isError = false, cwd = '/repo') => ({ cwd, timestamp: at(), message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

function read(entries) {
  const activity = createActivity();
  for (const e of entries) readEntry(activity, e);
  return summarize(activity);
}

describe('what a transcript says', () => {
  test('every cwd, the worktrees entered with their branch, the folders edited in', () => {
    const s = read([
      { cwd: '/repo', timestamp: at(), message: { content: 'hello' } },
      use('t1', 'EnterWorktree', { name: 'fix-x' }),
      result('t1', 'Entered worktree at /repo/.claude/worktrees/fix-x on branch ada/fix-x. The session is now working in the worktree.'),
      use('t2', 'Edit', { file_path: '/repo/.claude/worktrees/fix-x/src/a.js' }, '/repo/.claude/worktrees/fix-x'),
    ]);
    const byDir = Object.fromEntries(s.dirs.map((d) => [d.dir, d]));
    expect(byDir[P('/repo/.claude/worktrees/fix-x')]).toMatchObject({ kinds: expect.arrayContaining(['enter', 'cwd']), branch: 'ada/fix-x' });
    expect(byDir[P('/repo/.claude/worktrees/fix-x/src')]).toMatchObject({ kinds: ['edit'] });
    expect(byDir[P('/repo')]).toMatchObject({ kinds: ['cwd'], branch: null });
    expect(s.edits).toEqual([{ file: P('/repo/.claude/worktrees/fix-x/src/a.js'), at: expect.any(Number) }]);
    expect(s.dirs.map((d) => d.at)).toEqual([...s.dirs.map((d) => d.at)].sort((a, b) => b - a)); // newest first
  });

  test('a worktree path with a space, a branch with dots', () => {
    const s = read([
      use('t1', 'EnterWorktree', { name: 'rel' }),
      result('t1', 'Entered worktree at /Users/Jo Do/repo/.claude/worktrees/rel on branch release/1.2. The session is now working in the worktree.'),
    ]);
    expect(s.dirs.find((d) => d.kinds.includes('enter'))).toMatchObject({ dir: P('/Users/Jo Do/repo/.claude/worktrees/rel'), branch: 'release/1.2' });
  });

  test('a pull request is the URL gh pr create printed, on a line of its own', () => {
    const s = read([
      use('t1', 'Bash', { command: '/opt/homebrew/bin/gh pr create --repo acme/app --title "[ENG-1] fix" --body x' }),
      result('t1', 'Warning: 1 uncommitted change\nhttps://github.com/acme/app/pull/1215\n'),
    ]);
    expect(s.prs).toEqual([{ host: 'github.com', owner: 'acme', repo: 'app', number: 1215, url: 'https://github.com/acme/app/pull/1215', at: expect.any(Number) }]);
  });

  test('URLs in any other output are not pull requests of the session', () => {
    const s = read([
      use('t1', 'Bash', { command: 'sed -n 1,40p tests/pr.test.ts' }),
      result('t1', 'https://github.com/acme/web/pull/42\n'),
      use('t2', 'Bash', { command: 'gh pr create --title x' }),
      result('t2', 'Created https://github.com/acme/app/pull/7 (see release notes)'),
      use('t3', 'Bash', { command: 'gh pr create --title y' }),
      result('t3', 'https://github.com/acme/app/pull/8', true),
    ]);
    expect(s.prs).toEqual([]);
  });

  test('a tool result without its call is ignored, and a call is paired once', () => {
    const s = read([
      result('nope', 'https://github.com/acme/app/pull/1'),
      use('t1', 'Bash', { command: 'gh pr create' }),
      result('t1', 'https://github.com/acme/app/pull/2'),
      result('t1', 'https://github.com/acme/app/pull/3'),
    ]);
    expect(s.prs.map((p) => p.number)).toEqual([2]);
  });
});

describe('reading the file', () => {
  let root;
  let projectDir;
  let worktreeDir;
  let service;
  const SID = '0ccdd0c8-7072-40e4-9180-123beb328ee6';
  const line = (e) => `${JSON.stringify(e)}\n`;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-activity-'));
    projectDir = path.join(root, 'proj');
    worktreeDir = path.join(root, 'proj-wt');
    fs.mkdirSync(projectDir);
    fs.mkdirSync(worktreeDir);
    service = createSessionActivityService({ dirsFor: () => [{ dir: projectDir }, { dir: worktreeDir }] });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));

  test('reads only what was added since the last call, a half-written line included', async () => {
    const file = path.join(projectDir, `${SID}.jsonl`);
    fs.writeFileSync(file, line({ cwd: '/a', timestamp: at() }));
    expect((await service.read('/p', SID)).dirs.map((d) => d.dir)).toEqual([P('/a')]);

    const next = line({ cwd: '/b', timestamp: at() });
    fs.appendFileSync(file, next.slice(0, 10));
    expect((await service.read('/p', SID)).dirs.map((d) => d.dir)).toEqual([P('/a')]);
    fs.appendFileSync(file, next.slice(10));
    expect((await service.read('/p', SID)).dirs.map((d) => d.dir).sort()).toEqual([P('/a'), P('/b')]);
  });

  test('a transcript that moved with the session is found again and read whole', async () => {
    fs.writeFileSync(path.join(projectDir, `${SID}.jsonl`), line({ cwd: '/a', timestamp: at() }));
    await service.read('/p', SID);
    fs.renameSync(path.join(projectDir, `${SID}.jsonl`), path.join(worktreeDir, `${SID}.jsonl`));
    fs.appendFileSync(path.join(worktreeDir, `${SID}.jsonl`), line({ cwd: '/c', timestamp: at() }));
    expect((await service.read('/p', SID)).dirs.map((d) => d.dir).sort()).toEqual([P('/a'), P('/c')]);
  });

  test('a character split across two reads survives', async () => {
    const file = path.join(projectDir, `${SID}.jsonl`);
    const entry = line({ cwd: '/projets/équipe', timestamp: at() });
    const bytes = Buffer.from(entry);
    const cut = bytes.indexOf(Buffer.from('é')) + 1; // inside the two bytes of "é"
    fs.writeFileSync(file, bytes.subarray(0, cut));
    await service.read('/p', SID);
    fs.appendFileSync(file, bytes.subarray(cut));
    expect((await service.read('/p', SID)).dirs.map((d) => d.dir)).toEqual([P('/projets/équipe')]);
  });

  test('no transcript, or an id that is not one, reads as nothing', async () => {
    await expect(service.read('/p', SID)).resolves.toBeNull();
    await expect(service.read('/p', '../../etc/passwd')).resolves.toBeNull();
    await expect(service.read('/p', 'tab:1')).resolves.toBeNull();
  });
});
