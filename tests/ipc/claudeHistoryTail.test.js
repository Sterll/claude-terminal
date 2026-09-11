// Reading a transcript from the end.
//
// `loadSessionHistory` only ever replays the last few hundred messages, but it
// used to stream and JSON.parse the whole file to find them — 28 MB on this
// repository's own session. The tail is now read backwards, block by block,
// which puts the cost in proportion to the window instead of the file.
//
// Everything here is about that read producing exactly what the forward one
// did. The reference is the loader's own sequential path (`limit: 0`, still the
// implementation the tail read replaced), windowed the way the forward reader
// windowed it — so a divergence fails here rather than in a resumed session.

const realOs = require('os');
const fs = require('fs');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(realOs.tmpdir(), 'ct-history-tail-'));

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() }
}));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => global.__CT_TMP_HOME__
}));

global.__CT_TMP_HOME__ = TMP_HOME;

const { loadSessionHistory, loadToolResultOutput } = require('../../src/main/ipc/claude.ipc');

const PROJECT_PATH = '/tmp/tail-project';
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function sessionsDir() {
  return path.join(TMP_HOME, '.claude', 'projects', PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Write raw transcript lines as this project's session file. */
function writeLines(lines, { eol = '\n', trailing = true } = {}) {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const body = lines.join(eol) + (trailing ? eol : '');
  fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), body, 'utf8');
  return Buffer.byteLength(body, 'utf8');
}

const userLine = (i, text) => JSON.stringify({
  type: 'user', uuid: `u-${i}`, sessionId: SESSION_ID,
  message: { role: 'user', content: text ?? `prompt ${i}` }
});

const assistantLine = (i, extra = {}) => JSON.stringify({
  type: 'assistant', uuid: `a-${i}`, sessionId: SESSION_ID,
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: `thinking ${i}` },
      { type: 'tool_use', id: `t-${i}`, name: 'Bash', input: { command: `echo ${i}` } },
      { type: 'text', text: `answer ${i}` }
    ],
    ...extra
  }
});

const resultLine = (i, output) => JSON.stringify({
  type: 'user', uuid: `r-${i}`, sessionId: SESSION_ID,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${i}`, content: output ?? `out ${i}` }] }
});

/** A conversation of `turns` exchanges; `fat` turns carry an oversized result. */
function conversation(turns, fatEvery = 0, fatBytes = 0) {
  const lines = [];
  for (let i = 0; i < turns; i++) {
    lines.push(userLine(i));
    lines.push(assistantLine(i, i === turns - 1 ? { usage: { input_tokens: 5, cache_read_input_tokens: 1234 } } : {}));
    const fat = fatEvery && i % fatEvery === 0;
    lines.push(resultLine(i, fat ? `out ${i} ` + 'x'.repeat(fatBytes) : undefined));
  }
  return lines;
}

/**
 * What the forward reader would have returned for this window: the whole
 * conversation, cut to the last `limit` messages and realigned onto a user turn.
 */
async function forwardWindow(limit) {
  const all = (await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 0 })).messages;
  if (all.length <= limit) return all;
  let start = all.length - limit;
  for (let i = start; i < all.length; i++) {
    if (all[i].role === 'user') { start = i; break; }
  }
  return all.slice(start);
}

afterAll(() => {
  // Windows releases the transcript's handle asynchronously — see the note in
  // claude.ipc.test.js. Retries, not force, are what make this reliable.
  fs.rmSync(TMP_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('reading the tail backwards', () => {
  test.each([5, 17, 50, 400])('returns exactly what a forward read would, at limit %i', async (limit) => {
    writeLines(conversation(120));
    const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit });
    expect(tail.messages).toEqual(await forwardWindow(limit));
  });

  test('survives lines larger than one read block', async () => {
    // 400 KB of output in a single line, against a 256 KB block: the line is
    // rebuilt from three reads before it can be parsed at all.
    const size = writeLines(conversation(40, 4, 400 * 1024));
    expect(size).toBeGreaterThan(3 * 1024 * 1024);

    const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 30 });
    expect(tail.messages).toEqual(await forwardWindow(30));
    expect(tail.messages.length).toBe(30);
  });

  test.each([0, 1, 2, 3, 5, 7, 11])(
    'decodes multi-byte characters split across a block boundary (+%i bytes)',
    async (pad) => {
      // A 4-byte character sits every few bytes through a line well over one
      // block long. Blocks are counted back from the end of the file, so the
      // padding goes *after* the filler — padding before it would move the file
      // and the boundary by the same amount and never change the alignment.
      // Decoding per block instead of per line mangles the character the
      // boundary lands in.
      const filler = '🙂é漢'.repeat(30000); // ~300 KB, well past REVERSE_BLOCK_BYTES
      writeLines([
        userLine(0, filler),
        assistantLine(1),
        resultLine(1, 'z'.repeat(pad))
      ]);

      const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 10 });
      expect(tail.messages[0].text).toBe(filler);
      expect(tail.messages).toEqual(await forwardWindow(10));
    }
  );

  test('reads a transcript written with CRLF breaks', async () => {
    writeLines(conversation(6), { eol: '\r\n' });
    const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 10 });
    expect(tail.messages.map(m => m.text || m.toolName)).toContain('prompt 5');
    expect(tail.messages).toEqual(await forwardWindow(10));
  });

  test('an empty file returns an empty conversation', async () => {
    writeLines([], { trailing: false });
    expect(await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 10 }))
      .toEqual({ messages: [], total: 0, truncated: false, contextTokens: 0 });
  });

  test('a single line with no trailing newline is still a message', async () => {
    writeLines([userLine(0, 'only prompt')], { trailing: false });
    const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 10 });
    expect(tail.messages).toEqual([{ role: 'user', text: 'only prompt', uuid: 'u-0' }]);
    expect(tail.total).toBe(1);
    expect(tail.truncated).toBe(false);
  });

  test('a file of nothing but blank lines is empty, not malformed', async () => {
    writeLines(['', '', '']);
    const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 10 });
    expect(tail.messages).toEqual([]);
    expect(tail.truncated).toBe(false);
  });
});

describe('what the tail read reports about the rest of the file', () => {
  test('counts the conversation exactly when it fits in the window', async () => {
    writeLines(conversation(3));
    const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 400 });
    expect(tail.total).toBe(15);
    expect(tail.truncated).toBe(false);
  });

  test('reports the count as unknown rather than guessing when it stopped early', async () => {
    writeLines(conversation(200));
    const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 50 });
    expect(tail.total).toBeNull();
    expect(tail.truncated).toBe(true);
  });

  test('lines that carry no message are not hidden history', async () => {
    // Exactly `limit` messages, behind a pile of CLI plumbing. The walk has to
    // go past all of it to find out that nothing is actually hidden, otherwise
    // the chat offers to load earlier messages that do not exist.
    const meta = Array.from({ length: 20 }, (_, i) => JSON.stringify({
      type: 'user', uuid: `m-${i}`, isMeta: true, sessionId: SESSION_ID,
      message: { role: 'user', content: 'caveat' }
    }));
    writeLines([...meta, userLine(0), userLine(1), userLine(2)]);

    const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 3 });
    expect(tail.truncated).toBe(false);
    expect(tail.total).toBe(3);
    expect(tail.messages).toHaveLength(3);
  });

  test('limit 0 still returns the whole conversation, counted', async () => {
    writeLines(conversation(200));
    const full = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 0 });
    expect(full.messages).toHaveLength(1000);
    expect(full.total).toBe(1000);
    expect(full.truncated).toBe(false);
  });

  test('`until` keeps the forward read, fork point and count included', async () => {
    // The tail read cannot serve a fork: its stop condition is an uuid in the
    // middle of the file, and everything before it is what the fork keeps.
    writeLines(conversation(200));
    const forked = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 50, until: 'a-100' });

    // 100 full turns of five messages, then the forked turn: its prompt and the
    // three blocks of the reply the fork stops on.
    expect(forked.total).toBe(504);
    expect(forked.messages[forked.messages.length - 1]).toMatchObject({ type: 'text', text: 'answer 100' });
    expect(forked.messages.some(m => m.text === 'prompt 101')).toBe(false);
  });
});

describe('context occupancy', () => {
  test('is the same figure the forward read reported', async () => {
    writeLines(conversation(120));
    const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 20 });
    const full = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 0 });
    expect(tail.contextTokens).toBe(full.contextTokens);
    expect(tail.contextTokens).toBe(1239);
  });

  test('is found even when it sits well before the replayed window', async () => {
    // The session ended on a long run of subagent frames, which measure their
    // own window and never this one. The walk keeps going back for the figure.
    const lines = [
      assistantLine(0, { usage: { input_tokens: 2, cache_read_input_tokens: 232050, cache_creation_input_tokens: 1675 } })
    ];
    for (let i = 1; i < 300; i++) {
      lines.push(JSON.stringify({
        type: 'assistant', uuid: `s-${i}`, isSidechain: true, sessionId: SESSION_ID,
        message: { role: 'assistant', content: [{ type: 'text', text: `sub ${i}` }], usage: { input_tokens: 7 } }
      }));
    }
    writeLines(lines);

    const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 10 });
    expect(tail.contextTokens).toBe(233727);
    expect(tail.truncated).toBe(true);
  });

  test('is zero, not stale, when the transcript never measured it', async () => {
    writeLines([userLine(0), userLine(1)]);
    const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 1 });
    expect(tail.contextTokens).toBe(0);
  });
});

describe('tool results too large to replay', () => {
  const big = 'y'.repeat(60000);

  test('a clipped result says so, and how much was left behind', async () => {
    writeLines([userLine(0), assistantLine(0), resultLine(0, big)]);
    const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 10 });
    const result = tail.messages.find(m => m.role === 'tool_result');

    expect(result.output).toHaveLength(2000);
    expect(result.outputTruncated).toBe(true);
    expect(result.outputLength).toBe(big.length);
  });

  test('a result that fits carries no truncation marker', async () => {
    writeLines([userLine(0), assistantLine(0), resultLine(0, 'short')]);
    const tail = await loadSessionHistory(PROJECT_PATH, SESSION_ID, { limit: 10 });
    const result = tail.messages.find(m => m.role === 'tool_result');

    expect(result.output).toBe('short');
    expect(result).not.toHaveProperty('outputTruncated');
  });

  test('the full output comes back on request', async () => {
    writeLines([userLine(0), assistantLine(0), resultLine(0, big)]);
    const res = await loadToolResultOutput(PROJECT_PATH, SESSION_ID, 't-0');

    expect(res.success).toBe(true);
    expect(res.output).toBe(big);
    expect(res.length).toBe(big.length);
    expect(res.truncated).toBe(false);
  });

  test('a result buried under megabytes of later turns is still found', async () => {
    const buried = JSON.stringify({
      type: 'user', uuid: 'r-buried', sessionId: SESSION_ID,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-buried', content: big }] }
    });
    writeLines([userLine(0), assistantLine(0), buried, ...conversation(40, 4, 400 * 1024)]);

    const res = await loadToolResultOutput(PROJECT_PATH, SESSION_ID, 't-buried');
    expect(res.success).toBe(true);
    expect(res.output).toBe(big);
  });

  test('an output made of content blocks is joined the way replay joins it', async () => {
    writeLines([userLine(0), assistantLine(0), JSON.stringify({
      type: 'user', uuid: 'r-0', sessionId: SESSION_ID,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 't-0',
          content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]
        }]
      }
    })]);

    const res = await loadToolResultOutput(PROJECT_PATH, SESSION_ID, 't-0');
    expect(res.output).toBe('first\nsecond');
  });

  test('an unknown id and an unknown session both fail rather than throw', async () => {
    writeLines([userLine(0), assistantLine(0), resultLine(0)]);

    expect(await loadToolResultOutput(PROJECT_PATH, SESSION_ID, 't-999'))
      .toMatchObject({ success: false });
    expect(await loadToolResultOutput(PROJECT_PATH, 'no-such-session', 't-0'))
      .toMatchObject({ success: false });
    expect(await loadToolResultOutput(PROJECT_PATH, SESSION_ID, ''))
      .toMatchObject({ success: false });
  });
});
