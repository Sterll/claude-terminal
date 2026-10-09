/**
 * A chat session hands its account's usage figures to the titlebar.
 *
 * The CLI forwards the plan's rate-limit headers on the stream as a
 * `rate_limit_event`. They are the only figures still arriving when the usage
 * endpoint answers 429, which is what it does to every caller once a few
 * sessions on the account hit the limit and each asks it why.
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
jest.mock('../../src/main/services/UsageService', () => ({
  applyRateLimitInfo: jest.fn(),
}));

const chatService = require('../../src/main/services/ChatService');
const UsageService = require('../../src/main/services/UsageService');

const SID = 'chat-rate-limit-1';

/** Captured from the SDK on a Team account, 2026-10-09. */
const RATE_LIMIT_INFO = {
  status: 'allowed_warning',
  resetsAt: 1793491200,
  rateLimitType: 'overage',
  utilization: 1,
  isUsingOverage: false,
  surpassedThreshold: 1,
  unifiedWindows: {
    five_hour: { utilization: 0.25, resetsAt: 1791584400 },
    seven_day: { utilization: 0.35, resetsAt: 1791698400 },
  },
};
const rateLimitEvent = { type: 'rate_limit_event', rate_limit_info: RATE_LIMIT_INFO, uuid: 'u1', session_id: 's1' };
const okResult = { type: 'result', subtype: 'success', is_error: false };

/** Run the stream loop over `messages` and return everything it sent. */
async function drain(messages, session = {}) {
  const sent = [];
  chatService.sessions.set(SID, {
    accountId: 'acc-team', projectId: 'p1', messageQueue: null, ...session,
  });
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

beforeEach(() => UsageService.applyRateLimitInfo.mockReset());

describe('rate limit figures from the chat stream', () => {
  test('reach the usage service under the account the session runs as', async () => {
    await drain([rateLimitEvent, okResult]);
    expect(UsageService.applyRateLimitInfo).toHaveBeenCalledWith('acc-team', RATE_LIMIT_INFO);
  });

  test('an unbound session reports them for the machine-wide login', async () => {
    await drain([rateLimitEvent, okResult], { accountId: null });
    expect(UsageService.applyRateLimitInfo).toHaveBeenCalledWith(null, RATE_LIMIT_INFO);
  });

  test('a failure to apply them does not end the session', async () => {
    UsageService.applyRateLimitInfo.mockImplementation(() => { throw new Error('boom'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sent = await drain([rateLimitEvent, okResult]);
      expect(sent.find(s => s.ch === 'lifecycle:end').data.status).toBe('success');
    } finally { warn.mockRestore(); }
  });

  test('leave every other message alone', async () => {
    await drain([{ type: 'assistant', message: { role: 'assistant', content: [] } }, okResult]);
    expect(UsageService.applyRateLimitInfo).not.toHaveBeenCalled();
  });
});
