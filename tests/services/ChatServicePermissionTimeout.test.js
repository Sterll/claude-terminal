// Permission prompts from the SDK's canUseTool callback: what an unanswered
// prompt resolves to, which tools never time out, and how every surface is
// told once a prompt is settled.

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app' },
  BrowserWindow: { getAllWindows: () => [] },
}));

jest.mock('child_process', () => ({
  exec: jest.fn(),
  execSync: jest.fn(),
  execFileSync: jest.fn(() => ''),
}));

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({}), { virtual: true });

const chatService = require('../../src/main/services/ChatService');

const FIVE_MINUTES = 5 * 60 * 1000;

describe('ChatService permission prompts', () => {
  let sent;

  beforeEach(() => {
    jest.useFakeTimers();
    sent = [];
    chatService._send = jest.fn((channel, data) => sent.push({ channel, data }));
    chatService.sessions.set('s1', { alwaysAllow: false });
    chatService.pendingPermissions.clear();
  });

  afterEach(() => {
    chatService.sessions.delete('s1');
    chatService.pendingPermissions.clear();
    jest.useRealTimers();
  });

  const request = (toolName, options = {}) =>
    chatService._handlePermission('s1', toolName, { command: 'ls' }, options);

  const lastRequestId = () =>
    sent.filter(e => e.channel === 'chat-permission-request').pop().data.requestId;

  const settled = () => sent.filter(e => e.channel === 'chat-permission-resolved').map(e => e.data);

  test('an unanswered tool prompt denies with a message the CLI accepts', async () => {
    const p = request('Bash');
    const requestId = lastRequestId();

    jest.advanceTimersByTime(FIVE_MINUTES);

    // The CLI rejects `{ behavior: 'deny' }` without a string message as an
    // invalid permission result, which reaches the model as a harness error.
    const result = await p;
    expect(result.behavior).toBe('deny');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);

    expect(settled()).toEqual([{ sessionId: 's1', requestId, toolName: 'Bash', reason: 'timeout' }]);
    expect(chatService.pendingPermissions.size).toBe(0);
  });

  test.each(['ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion'])(
    '%s keeps waiting for the user past the timeout',
    async (toolName) => {
      let resolved = false;
      const p = request(toolName).then((r) => { resolved = true; return r; });
      const requestId = lastRequestId();

      jest.advanceTimersByTime(60 * 60 * 1000);
      await Promise.resolve();

      expect(resolved).toBe(false);
      expect(chatService.pendingPermissions.size).toBe(1);
      expect(settled()).toEqual([]);

      const answer = { behavior: 'allow', updatedInput: { plan: 'x' } };
      expect(chatService.resolvePermission(requestId, answer)).toBe(true);
      await expect(p).resolves.toEqual(answer);
    }
  );

  test('answering emits the settle event so other surfaces retract the prompt', async () => {
    const p = request('Bash');
    const requestId = lastRequestId();

    expect(chatService.resolvePermission(requestId, { behavior: 'deny', message: 'no' })).toBe(true);

    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'no' });
    expect(settled()).toEqual([{ sessionId: 's1', requestId, toolName: 'Bash', reason: 'answered' }]);

    // The timer went with it: nothing fires later.
    jest.advanceTimersByTime(FIVE_MINUTES);
    expect(settled()).toHaveLength(1);
  });

  test('resolvePermission reports false when nothing is pending under that id', async () => {
    expect(chatService.resolvePermission('perm-unknown', { behavior: 'allow', updatedInput: {} })).toBe(false);

    const p = request('Bash');
    const requestId = lastRequestId();
    jest.advanceTimersByTime(FIVE_MINUTES);
    await p;

    // A click that lands after the timeout has nothing left to resolve; the
    // caller uses this to show "expired" instead of "approved".
    expect(chatService.resolvePermission(requestId, { behavior: 'allow', updatedInput: {} })).toBe(false);
    expect(settled()).toHaveLength(1);
  });

  test('an interrupted turn aborts the prompt and settles it as aborted', async () => {
    const controller = new AbortController();
    const p = request('Bash', { signal: controller.signal });
    const requestId = lastRequestId();

    controller.abort();

    await expect(p).rejects.toThrow('Aborted');
    expect(chatService.pendingPermissions.size).toBe(0);
    expect(settled()).toEqual([{ sessionId: 's1', requestId, toolName: 'Bash', reason: 'aborted' }]);

    jest.advanceTimersByTime(FIVE_MINUTES);
    expect(settled()).toHaveLength(1);
  });
});
