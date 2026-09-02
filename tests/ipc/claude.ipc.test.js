// Claude session-history IPC tests
//
// Long sessions in the wild reach tens of thousands of messages; the loader must
// return a bounded tail instead of the whole transcript.

const realOs = require('os');
const fs = require('fs');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(realOs.tmpdir(), 'ct-claude-ipc-'));

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() }
}));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => global.__CT_TMP_HOME__
}));

global.__CT_TMP_HOME__ = TMP_HOME;

const { loadSessionHistory } = require('../../src/main/ipc/claude.ipc');

const PROJECT_PATH = '/tmp/demo-project';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function sessionsDir() {
  return path.join(TMP_HOME, '.claude', 'projects', PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Write a transcript of `turns` user/assistant/tool exchanges. */
function writeSession(turns) {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({
      type: 'user', uuid: `u-${i}`, sessionId: SESSION_ID,
      message: { role: 'user', content: `prompt ${i}` }
    }));
    lines.push(JSON.stringify({
      type: 'assistant', uuid: `a-${i}`, sessionId: SESSION_ID,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: `thinking ${i}` },
          { type: 'tool_use', id: `t-${i}`, name: 'Bash', input: { command: `echo ${i}` } },
          { type: 'text', text: `answer ${i}` }
        ]
      }
    }));
    lines.push(JSON.stringify({
      type: 'user', uuid: `r-${i}`, sessionId: SESSION_ID,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${i}`, content: `out ${i}` }] }
    }));
  }
  fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n');
}

afterAll(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('loadSessionHistory', () => {
  test('returns every message and total when the session fits in the window', async () => {
    writeSession(3);
    const { messages, total, truncated } = await loadSessionHistory(PROJECT_PATH, SESSION_ID);

    // 3 turns x (user + thinking + tool_use + text + tool_result)
    expect(total).toBe(15);
    expect(messages).toHaveLength(15);
    expect(truncated).toBe(false);
    expect(messages[0]).toMatchObject({ role: 'user', text: 'prompt 0' });
  });

  test('caps a long session to the tail and reports it as truncated', async () => {
    writeSession(200); // 1000 messages
    const { messages, total, truncated } = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 50 });

    expect(total).toBe(1000);
    expect(truncated).toBe(true);
    expect(messages.length).toBeLessThanOrEqual(50);
    // The tail is realigned onto a user turn, never mid tool-run
    expect(messages[0].role).toBe('user');
    // ...and it really is the end of the conversation
    expect(messages[messages.length - 1]).toMatchObject({ role: 'tool_result', output: 'out 199' });
  });

  test('a larger limit returns a superset ending on the same message', async () => {
    writeSession(200);
    const small = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 50 });
    const large = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 150 });

    expect(large.messages.length).toBeGreaterThan(small.messages.length);
    const overlap = large.messages.slice(large.messages.length - small.messages.length);
    expect(overlap).toEqual(small.messages);
  });

  test('limit 0 disables truncation', async () => {
    writeSession(200);
    const { messages, total, truncated } = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 0 });

    expect(messages).toHaveLength(1000);
    expect(total).toBe(1000);
    expect(truncated).toBe(false);
  });

  test('stops at the fork point named by `until`', async () => {
    writeSession(200);
    const { messages } = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 0, until: 'a-4' });

    const last = messages[messages.length - 1];
    expect(last).toMatchObject({ role: 'assistant', type: 'text', text: 'answer 4' });
    expect(messages.some(m => m.text === 'prompt 5')).toBe(false);
  });

  test('returns an empty result for an unknown session', async () => {
    writeSession(1);
    const result = await loadSessionHistory(PROJECT_PATH, 'does-not-exist');
    expect(result).toEqual({ messages: [], total: 0, truncated: false });
  });
});
