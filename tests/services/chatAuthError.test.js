/**
 * A chat session that dies of a lost login is reported as `errorType: 'auth'`,
 * which is what puts the Reconnect button on the tab's error, instead of a
 * sentence sending the user to a terminal.
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
  listAccounts: jest.fn(async () => ({ accounts: [], defaultId: null })),
}));

const chatService = require('../../src/main/services/ChatService');

const SID = 'chat-auth-1';

/** Run the stream loop over a stream that dies with `message`. */
async function dieWith(message, session = {}) {
  const sent = [];
  chatService.sessions.set(SID, { accountId: 'acc-1', projectId: 'p1', messageQueue: null, ...session });
  const stubs = {
    _send: (ch, data) => sent.push({ ch, data }),
    _emitLifecycle: () => {},
    _emitEvent: () => {},
    _emitMessage: () => {},
    _emitAccountLimit: async () => {},
    _rejectPendingPermissions: () => {},
  };
  Object.assign(chatService, stubs);
  try {
    await chatService._processStream(SID, (async function* () { yield* []; throw new Error(message); })());
  } finally {
    for (const key of Object.keys(stubs)) delete chatService[key];
    chatService.sessions.delete(SID);
  }
  return sent.find(s => s.ch === 'chat-error')?.data;
}

describe('a lost login', () => {
  test.each([
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
    'Not logged in · Please run /login',
    'Invalid API key · Please run /login',
  ])('is reported as auth: %s', async (message) => {
    expect((await dieWith(message))?.errorType).toBe('auth');
  });

  test('anything else stays generic', async () => {
    expect((await dieWith('fetch failed: ECONNREFUSED'))?.errorType).toBe('generic');
    expect((await dieWith('Claude Code process exited with code 1'))?.errorType).toBe('generic');
  });

  test('a limit wins over the words around it', async () => {
    expect((await dieWith('429 Too Many Requests: usage limit reached'))?.errorType).toBe('usage_limit');
  });

  test('_isAuthError reads stderr too, and is not fooled by a number that merely contains 401', () => {
    expect(chatService._isAuthError('exited with code 1', 'Error: 401 Unauthorized')).toBe(true);
    expect(chatService._isAuthError('request 14012 failed')).toBe(false);
  });
});
