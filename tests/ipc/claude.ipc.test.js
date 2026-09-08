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

const { loadSessionHistory, parseSessionReplay } = require('../../src/main/ipc/claude.ipc');

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

  test('realigns even when the sliding window ends exactly on a trim', async () => {
    // 15 messages against limit 7: the buffer is trimmed back to exactly 7 on the
    // very last push, so the tail is left starting mid-turn unless the realignment
    // also triggers on a trim that already happened.
    writeSession(3);
    const { messages, total, truncated } = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 7 });

    expect(total).toBe(15);
    expect(truncated).toBe(true);
    expect(messages[0]).toMatchObject({ role: 'user', text: 'prompt 2' });
    expect(messages[messages.length - 1]).toMatchObject({ role: 'tool_result', output: 'out 2' });
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
    expect(result).toEqual({ messages: [], total: 0, truncated: false, contextTokens: 0 });
  });

  // The chat's context gauge reads this: a resumed conversation has no live
  // session to query, so the tail of the transcript is the only source.
  test('reports the context occupancy of the last turn, cache included', () => {
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const turn = (n, usage) => JSON.stringify({
      type: 'assistant', uuid: `a-${n}`, sessionId: SESSION_ID,
      message: { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }], usage }
    });
    fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), [
      turn(0, { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 50 }),
      turn(1, { input_tokens: 2, cache_creation_input_tokens: 1675, cache_read_input_tokens: 232050 }),
    ].join('\n') + '\n');

    return loadSessionHistory(PROJECT_PATH, SESSION_ID).then(result => {
      expect(result.contextTokens).toBe(233727);
    });
  });

  test('opens on what a compaction left when nothing has been said since', async () => {
    // A session closed right after /compact. The last frame with a usage is
    // the big one from before; the boundary says what survived, and only the
    // summary and prompts follow it until the next reply.
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), [
      JSON.stringify({
        type: 'assistant', uuid: 'a-0', sessionId: SESSION_ID,
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer 0' }], usage: { input_tokens: 2, cache_read_input_tokens: 36216 } }
      }),
      JSON.stringify({
        type: 'system', subtype: 'compact_boundary', uuid: 's-1', sessionId: SESSION_ID, isSidechain: false,
        content: 'Conversation compacted',
        compactMetadata: { trigger: 'manual', preTokens: 36218, postTokens: 3356 }
      }),
      JSON.stringify({
        type: 'user', uuid: 'u-2', sessionId: SESSION_ID, isCompactSummary: true,
        message: { role: 'user', content: 'This session is being continued from a previous conversation.' }
      }),
    ].join('\n') + '\n');

    const result = await loadSessionHistory(PROJECT_PATH, SESSION_ID);
    expect(result.contextTokens).toBe(3356);
  });

  test('keeps the real tail figure when the replay window is trimmed', async () => {
    // A trimmed replay drops early messages; the gauge must still describe the
    // end of the conversation, not the last message that survived the window.
    writeSession(50);
    const trimmed = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 5 });
    expect(trimmed.truncated).toBe(true);
    // This fixture carries no usage at all, so "unknown" must read as 0 rather
    // than as a stale number from somewhere else.
    expect(trimmed.contextTokens).toBe(0);
  });
});

// What the live stream drew, the replay has to draw too. Everything below is a
// shape the CLI writes to the transcript and the chat renders as something other
// than a message bubble — an error box, a notice, or nothing at all.
describe('loadSessionHistory — transcript shapes', () => {
  /** Write the given raw transcript lines as this project's session file. */
  function writeLines(lines) {
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${SESSION_ID}.jsonl`),
      lines.map(l => JSON.stringify(l)).join('\n') + '\n'
    );
  }

  const prompt = (text, extra = {}) => ({
    type: 'user', uuid: 'u-1', message: { role: 'user', content: text }, ...extra
  });

  test('an API failure comes back as an error, not as a reply from Claude', async () => {
    writeLines([
      prompt('hello'),
      {
        type: 'assistant', uuid: 'a-1', isApiErrorMessage: true,
        error: 'rate_limit', apiErrorStatus: 429,
        message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 429 rate limit' }] }
      }
    ]);
    const { messages } = await loadSessionHistory(PROJECT_PATH, SESSION_ID);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: 'error', errorCode: 'rate_limit', text: 'API Error: 429 rate limit'
    });
    // ...and never also as the assistant text it is dressed up as
    expect(messages.some(m => m.role === 'assistant')).toBe(false);
  });

  test('the stream-json spelling of the flag counts too', async () => {
    writeLines([{
      type: 'assistant', uuid: 'a-1', is_api_error_message: true, error: 'server_error',
      message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 529' }] }
    }]);
    const { messages } = await loadSessionHistory(PROJECT_PATH, SESSION_ID);
    expect(messages[0]).toMatchObject({ role: 'error', errorCode: 'server_error' });
  });

  test('a compaction replays as its boundary notice, not as the summary it wrote', async () => {
    writeLines([
      prompt('hello'),
      {
        type: 'system', subtype: 'compact_boundary', uuid: 's-1',
        compactMetadata: { trigger: 'auto', preTokens: 935547 }
      },
      {
        type: 'user', uuid: 'u-2', isCompactSummary: true, isVisibleInTranscriptOnly: true,
        message: { role: 'user', content: 'This session is being continued from a previous conversation...' }
      },
      prompt('carry on', { uuid: 'u-3' })
    ]);
    const { messages } = await loadSessionHistory(PROJECT_PATH, SESSION_ID);

    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({ role: 'notice', icon: 'compact', preTokens: 935547 });
    expect(messages.some(m => m.text?.startsWith('This session is being continued'))).toBe(false);
  });

  test('a slash command replays as the line the user typed, then its output', async () => {
    writeLines([
      {
        type: 'user', uuid: 'u-0', isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' }
      },
      prompt('<command-name>/model</command-name>\n  <command-message>model</command-message>\n  <command-args>opus[1m]</command-args>'),
      prompt('<local-command-stdout>Set model to claude-opus-5[1m]</local-command-stdout>', { uuid: 'u-2' })
    ]);
    const { messages } = await loadSessionHistory(PROJECT_PATH, SESSION_ID);

    expect(messages).toEqual([
      { role: 'user', text: '/model opus[1m]', uuid: 'u-1' },
      { role: 'notice', icon: 'command', text: 'Set model to claude-opus-5[1m]' }
    ]);
  });

  test('newer CLIs record the command output as a system line', async () => {
    writeLines([{
      type: 'system', subtype: 'local_command', uuid: 's-1',
      content: '<local-command-stdout>## Context Usage</local-command-stdout>'
    }]);
    const { messages } = await loadSessionHistory(PROJECT_PATH, SESSION_ID);
    expect(messages).toEqual([{ role: 'notice', icon: 'command', text: '## Context Usage' }]);
  });

  test('injected blocks are stripped, and a line that is only injection is dropped', async () => {
    writeLines([
      prompt('<system-reminder>\nThe user started a background task\n</system-reminder>'),
      prompt('<task-notification>\n<task-id>x</task-id>\n</task-notification>', { uuid: 'u-2' }),
      prompt('real question <system-reminder>ignore me</system-reminder>', { uuid: 'u-3' })
    ]);
    const { messages } = await loadSessionHistory(PROJECT_PATH, SESSION_ID);

    expect(messages).toEqual([{ role: 'user', text: 'real question', uuid: 'u-3' }]);
  });

  test('an answered question carries its answers to the replay', async () => {
    writeLines([
      {
        type: 'assistant', uuid: 'a-1',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use', id: 'q-1', name: 'AskUserQuestion',
            input: { questions: [{ question: 'Which base?', options: [{ label: 'main' }] }] }
          }]
        }
      },
      {
        type: 'user', uuid: 'r-1',
        toolUseResult: { answers: { 'Which base?': 'main' } },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q-1', content: 'answered' }] }
      }
    ]);
    const { messages } = await loadSessionHistory(PROJECT_PATH, SESSION_ID);

    expect(messages[1]).toMatchObject({
      role: 'tool_result', toolUseId: 'q-1', answers: { 'Which base?': 'main' }
    });
  });

  test('an ordinary tool result carries no answers field', async () => {
    writeLines([
      {
        type: 'assistant', uuid: 'a-1',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't-1', name: 'Bash', input: {} }] }
      },
      {
        type: 'user', uuid: 'r-1', toolUseResult: { stdout: 'hi' },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-1', content: 'hi' }] }
      }
    ]);
    const { messages } = await loadSessionHistory(PROJECT_PATH, SESSION_ID);
    expect(messages[1]).not.toHaveProperty('answers');
  });

  test('an image-only prompt survives having no text left', async () => {
    writeLines([{
      type: 'user', uuid: 'u-1',
      message: {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', data: 'abc', media_type: 'image/png' } }]
      }
    }]);
    const { messages } = await loadSessionHistory(PROJECT_PATH, SESSION_ID);
    expect(messages[0]).toMatchObject({ role: 'user', text: '', images: [{ base64: 'abc' }] });
  });
});

describe('parseSessionReplay', () => {
  test('counts the whole session but only ships the first page', async () => {
    writeSession(200); // 200 turns -> prompt + thinking + tool + response each
    const { steps, summary } = await parseSessionReplay(PROJECT_PATH, SESSION_ID, { limit: 50 });

    expect(summary.totalSteps).toBe(800);
    expect(summary.returned).toBe(50);
    expect(summary.truncated).toBe(true);
    expect(steps).toHaveLength(50);
    expect(steps[0].index).toBe(0);
    expect(steps[49].index).toBe(49);
  });

  test('a page equals the same slice of the unbounded parse', async () => {
    writeSession(60);
    const full = await parseSessionReplay(PROJECT_PATH, SESSION_ID, { limit: 0 });
    const page = await parseSessionReplay(PROJECT_PATH, SESSION_ID, { offset: 100, limit: 40 });

    expect(full.summary.truncated).toBe(false);
    expect(page.steps).toEqual(full.steps.slice(100, 140));
    expect(page.steps[0].index).toBe(100);
  });

  test('summary totals do not depend on the window', async () => {
    writeSession(60);
    const full = await parseSessionReplay(PROJECT_PATH, SESSION_ID, { limit: 0 });
    const page = await parseSessionReplay(PROJECT_PATH, SESSION_ID, { offset: 200, limit: 10 });

    expect(page.summary.totalSteps).toBe(full.summary.totalSteps);
    expect(page.summary.totalEstimatedTokens).toBe(full.summary.totalEstimatedTokens);
    expect(page.summary.toolBreakdown).toEqual(full.summary.toolBreakdown);
    expect(page.summary.uniqueFileCount).toBe(full.summary.uniqueFileCount);
  });

  test('attaches tool output to a windowed tool step', async () => {
    writeSession(5);
    const { steps } = await parseSessionReplay(PROJECT_PATH, SESSION_ID, { limit: 0 });
    const tools = steps.filter(s => s.type === 'tool');

    expect(tools).toHaveLength(5);
    expect(tools[0].toolName).toBe('Bash');
    expect(tools[0].toolOutput).toBe('out 0');
    expect(tools[0].estimatedOutputTokens).toBeGreaterThan(0);
  });

  test('counts output tokens of tool steps outside the window', async () => {
    writeSession(5);
    // Window starts past every tool step, yet their results still count
    const tail = await parseSessionReplay(PROJECT_PATH, SESSION_ID, { offset: 19, limit: 1 });
    const full = await parseSessionReplay(PROJECT_PATH, SESSION_ID, { limit: 0 });

    expect(tail.steps).toHaveLength(1);
    expect(tail.summary.totalEstimatedTokens).toBe(full.summary.totalEstimatedTokens);
  });

  test('returns an empty result for an unknown session', async () => {
    writeSession(1);
    const { steps, summary } = await parseSessionReplay(PROJECT_PATH, 'does-not-exist');
    expect(steps).toEqual([]);
    expect(summary.totalSteps).toBe(0);
  });
});
