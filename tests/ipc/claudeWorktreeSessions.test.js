// A session that moved into a worktree still belongs to its project.
//
// Claude Code files a transcript under the directory encoding of the cwd it runs
// in, and re-files the whole file when that cwd changes. Entering a worktree
// therefore moved a session out of the project's directory — and out of the app,
// which only ever read that one directory. These tests pin it back in place:
// listed, readable, resumable in the right cwd, and deletable.

const realOs = require('os');
const fs = require('fs');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(realOs.tmpdir(), 'ct-worktree-sessions-'));

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() }
}));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => global.__CT_TMP_HOME__
}));

global.__CT_TMP_HOME__ = TMP_HOME;

const {
  getClaudeSessions,
  loadSessionHistory,
  moveSession,
  invalidateSessionsCache,
} = require('../../src/main/ipc/claude.ipc');
const { getProjectSessionsDir, invalidateSessionDirs } = require('../../src/shared/session-dirs');

const REPO = path.join(TMP_HOME, 'repo');
const WORKTREE = path.join(REPO, '.claude', 'worktrees', 'snapshot-retention');
const OTHER_PROJECT = path.join(TMP_HOME, 'other');

const IN_PROJECT = 'aaaaaaaa-0000-0000-0000-000000000001';
const IN_WORKTREE = 'bbbbbbbb-0000-0000-0000-000000000002';

function addWorktree(name, worktreePath) {
  const entry = path.join(REPO, '.git', 'worktrees', name);
  fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, 'gitdir'), `${path.join(worktreePath, '.git')}\n`);
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${entry}\n`);
}

/** A transcript long enough to clear the "empty session" floor. */
function writeSession(cwd, sessionId, prompt) {
  const dir = getProjectSessionsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'user', uuid: 'u-1', sessionId, cwd, gitBranch: 'main',
      message: { role: 'user', content: prompt }
    }),
    JSON.stringify({
      type: 'assistant', uuid: 'a-1', sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(300) }] }
    }),
  ];
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

beforeEach(() => {
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.rmSync(path.join(TMP_HOME, '.claude'), { recursive: true, force: true });
  fs.mkdirSync(path.join(REPO, '.git'), { recursive: true });
  addWorktree('snapshot-retention', WORKTREE);
  invalidateSessionDirs();
  invalidateSessionsCache();
});

test('lists sessions that ran in a worktree alongside the project\'s own', async () => {
  writeSession(REPO, IN_PROJECT, 'started at the root');
  writeSession(WORKTREE, IN_WORKTREE, 'moved into the worktree');

  const sessions = await getClaudeSessions(REPO);
  const ids = sessions.map(s => s.sessionId);

  expect(ids).toContain(IN_PROJECT);
  expect(ids).toContain(IN_WORKTREE);
});

test('says where a worktree session runs, so it can be resumed there', async () => {
  writeSession(REPO, IN_PROJECT, 'started at the root');
  writeSession(WORKTREE, IN_WORKTREE, 'moved into the worktree');

  const sessions = await getClaudeSessions(REPO);
  const own = sessions.find(s => s.sessionId === IN_PROJECT);
  const moved = sessions.find(s => s.sessionId === IN_WORKTREE);

  expect(own).toMatchObject({ cwd: REPO, worktree: null, worktreeMissing: false });
  expect(moved).toMatchObject({
    cwd: WORKTREE, worktree: 'snapshot-retention', worktreeMissing: false
  });
});

test('a removed worktree keeps its history, resumable from the project root', async () => {
  writeSession(WORKTREE, IN_WORKTREE, 'ran in a worktree that is now gone');
  // `git worktree remove` takes the checkout and the .git/worktrees entry.
  fs.rmSync(path.join(REPO, '.git', 'worktrees', 'snapshot-retention'), { recursive: true });
  fs.rmSync(WORKTREE, { recursive: true });
  invalidateSessionDirs();
  invalidateSessionsCache();

  const [session] = await getClaudeSessions(REPO);
  expect(session).toMatchObject({
    sessionId: IN_WORKTREE, cwd: REPO, worktree: 'snapshot-retention', worktreeMissing: true
  });
});

test('reads the history of a worktree session from the project', async () => {
  writeSession(WORKTREE, IN_WORKTREE, 'moved into the worktree');

  const { messages } = await loadSessionHistory(REPO, IN_WORKTREE);
  expect(messages[0]).toMatchObject({ role: 'user', text: 'moved into the worktree' });
});

test('reports a genuinely unknown session as absent', async () => {
  writeSession(REPO, IN_PROJECT, 'started at the root');

  const { messages, total } = await loadSessionHistory(REPO, 'cccccccc-0000-0000-0000-000000000003');
  expect(messages).toEqual([]);
  expect(total).toBe(0);
});

test('the same session in both places is listed once, at its latest', async () => {
  // The project's copy is what the CLI left behind when the session moved on.
  writeSession(REPO, IN_WORKTREE, 'the half that stayed behind');
  const moved = writeSession(WORKTREE, IN_WORKTREE, 'the half that kept going');
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(moved, later, later);
  invalidateSessionsCache();

  const sessions = await getClaudeSessions(REPO);
  expect(sessions.filter(s => s.sessionId === IN_WORKTREE)).toHaveLength(1);
  expect(sessions[0].worktree).toBe('snapshot-retention');
});

test('moves a worktree session out to another project', async () => {
  writeSession(WORKTREE, IN_WORKTREE, 'moved into the worktree');
  fs.mkdirSync(OTHER_PROJECT, { recursive: true });

  const result = await moveSession(IN_WORKTREE, REPO, OTHER_PROJECT);
  expect(result.success).toBe(true);

  const target = path.join(getProjectSessionsDir(OTHER_PROJECT), `${IN_WORKTREE}.jsonl`);
  expect(fs.existsSync(target)).toBe(true);
  expect(fs.existsSync(path.join(getProjectSessionsDir(WORKTREE), `${IN_WORKTREE}.jsonl`))).toBe(false);
});
