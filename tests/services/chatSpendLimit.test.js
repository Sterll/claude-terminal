/**
 * A spend cap has to reach the account-switch offer.
 *
 * The CLI does not throw for it. It answers the turn with an ordinary assistant
 * message carrying the failure as text and a flag, and leaves the stream open —
 * so the tab keeps the process it was spawned with, and that process keeps the
 * credentials of the account that just ran out. Nothing here is about the
 * switch itself, which already worked: it is about the one event that starts
 * it, `chat-account-limit`, which used to fire only from the stream's `catch`
 * and therefore never fired for this.
 */

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app' },
  BrowserWindow: { getAllWindows: () => [] },
}));
jest.mock('child_process', () => ({
  exec: jest.fn(), execSync: jest.fn(), execFileSync: jest.fn(() => ''),
}));
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({}), { virtual: true });
jest.mock('../../src/main/services/AccountManager', () => ({
  listAccounts: jest.fn(async () => ({ accounts: [], defaultId: 'acc-default' })),
}));

const chatService = require('../../src/main/services/ChatService');

/** Verbatim from ~/.claude/projects — the message that started this. */
const SPEND_LIMIT = "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 5:20pm (Europe/Paris)";

const SID = 'chat-test-1';

const assistant = (text, extra = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'stop_sequence' },
  ...extra,
});
const okResult = { type: 'result', subtype: 'success', is_error: false };

/** Run the stream loop over `messages` and return everything it sent. */
async function drain(messages, session = {}) {
  const sent = [];
  chatService.sessions.set(SID, {
    accountId: 'acc-max', projectId: 'p1', messageQueue: null, ...session,
  });
  // Own properties shadowing the prototype rather than jest.spyOn, which
  // refuses a method the object does not have: `_emitEvent` is one the fork
  // adds and upstream does not, and this suite has to run on both.
  const stubs = {
    _send: (ch, data) => sent.push({ ch, data }),
    _emitLifecycle: (ev, _sid, extra) => sent.push({ ch: `lifecycle:${ev}`, data: extra }),
    _emitEvent: () => {},
    _emitMessage: () => {},
    _rejectPendingPermissions: () => {},
  };
  Object.assign(chatService, stubs);
  try {
    await chatService._processStream(SID, (async function* () { yield* messages; })());
  } finally {
    for (const key of Object.keys(stubs)) delete chatService[key];
    chatService.sessions.delete(SID);
  }
  return sent;
}

const limits = sent => sent.filter(s => s.ch === 'chat-account-limit');

describe('spend limit reported in-band', () => {
  test('_isUsageLimitError recognises the spend-cap phrasing', () => {
    expect(chatService._isUsageLimitError(SPEND_LIMIT)).toBe(true);
  });

  // The CLI tags the message `isApiErrorMessage` internally — the spelling that
  // lands in the transcript — and `is_api_error_message` on the stream-json
  // wire. Losing the offer to whichever one the SDK happens to forward is the
  // whole bug, so both have to work.
  test.each([
    ['transcript spelling', { isApiErrorMessage: true }],
    ['stream-json spelling', { is_api_error_message: true }],
  ])('offers the account switch (%s)', async (_label, flag) => {
    const sent = await drain([assistant(SPEND_LIMIT, flag), okResult]);

    expect(limits(sent)).toHaveLength(1);
    expect(limits(sent)[0].data).toMatchObject({
      sessionId: SID, error: SPEND_LIMIT, activeAccountId: 'acc-max', projectId: 'p1',
    });
  });

  test('offers it even unflagged, on the CLI phrasing alone', async () => {
    const sent = await drain([assistant(SPEND_LIMIT), okResult]);
    expect(limits(sent)).toHaveLength(1);
  });

  test('falls back to the default account when the session is unbound', async () => {
    const sent = await drain([assistant(SPEND_LIMIT, { isApiErrorMessage: true }), okResult],
      { accountId: null });
    expect(limits(sent)[0].data.activeAccountId).toBe('acc-default');
  });

  // Raised after the turn has settled, never mid-turn: acting on it closes the
  // session, and closing one mid-turn stamps an interrupted marker across the
  // transcript and stops the spinner the restart has just started.
  test('waits for the turn to end before raising it', async () => {
    const sent = await drain([assistant(SPEND_LIMIT, { isApiErrorMessage: true }), okResult]);
    const order = sent.map(s => s.ch);
    expect(order.indexOf('chat-account-limit')).toBeGreaterThan(
      order.lastIndexOf('chat-message'));
  });

  test('still raises it when the stream ends with no result', async () => {
    const sent = await drain([assistant(SPEND_LIMIT, { isApiErrorMessage: true })]);
    expect(limits(sent)).toHaveLength(1);
    const order = sent.map(s => s.ch);
    expect(order.indexOf('chat-account-limit')).toBeGreaterThan(order.indexOf('chat-done'));
  });

  test('reports the turn as failed rather than successful', async () => {
    const sent = await drain([assistant(SPEND_LIMIT, { isApiErrorMessage: true })]);
    const end = sent.find(s => s.ch === 'lifecycle:end');
    expect(end.data.status).toBe('error');
    expect(end.data.error).toBe(SPEND_LIMIT);
  });

  test('leaves an ordinary reply about spend limits alone', async () => {
    const sent = await drain([
      assistant('The spend limit banner should read "session limit resets 5:20pm".'),
      okResult,
    ]);
    expect(limits(sent)).toHaveLength(0);
    expect(sent.find(s => s.ch === 'lifecycle:end').data.status).toBe('success');
  });

  test('leaves a plain assistant turn alone', async () => {
    const sent = await drain([assistant('Done — the refactor is in.'), okResult]);
    expect(limits(sent)).toHaveLength(0);
  });
});
