// RemoteControlService unit tests — Claude Code Remote Control for chat sessions.
//
// Strategy: the SDK bridge, the credential store and settings.json are all
// mocked, so the tests exercise the only thing this service really owns — the
// translation between this app's chat events and the bridge's API, in both
// directions.

let mockSettings = {};

jest.mock('../../src/main/utils/paths', () => ({ settingsFile: '/virtual/settings.json' }));

jest.mock('fs', () => {
  const realFs = jest.requireActual('fs');
  return {
    ...realFs,
    readFileSync: jest.fn((p, enc) => {
      if (p === '/virtual/settings.json') return JSON.stringify(mockSettings);
      return realFs.readFileSync(p, enc);
    }),
  };
});

// ─── Fake bridge ────────────────────────────────────────────────────────────

let mockHandle;
let mockAttachOpts;
let mockCreateResult;
let mockCredsResult;
let mockBridgeAvailable;

function makeHandle() {
  return {
    write: jest.fn(),
    sendResult: jest.fn(),
    reportState: jest.fn(),
    reportMetadata: jest.fn(),
    reportDelivery: jest.fn(),
    sendControlRequest: jest.fn(),
    sendControlResponse: jest.fn(),
    sendControlCancelRequest: jest.fn(),
    reconnectTransport: jest.fn().mockResolvedValue(undefined),
    flush: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
    getSequenceNum: jest.fn(() => 7),
    getEpoch: jest.fn(() => 3),
    isConnected: jest.fn(() => true),
  };
}

jest.mock('../../src/main/utils/claudeBridge', () => ({
  loadBridge: jest.fn(async () => (mockBridgeAvailable ? {
    createCodeSession: jest.fn(async () => mockCreateResult),
    fetchRemoteCredentials: jest.fn(async () => mockCredsResult),
    attachBridgeSession: jest.fn(async (opts) => { mockAttachOpts = opts; return mockHandle; }),
    isCredentialsFailure: r => !!r?.terminal,
    isCredentialsRejection: r => r?.terminal === false,
    isCreateSessionFailure: r => !!r?.terminal,
  } : null)),
  getUnavailableReason: () => 'stubbed out',
  getApiBaseUrl: () => 'https://api.anthropic.com',
}));

jest.mock('../../src/main/utils/claudeCredentials', () => ({
  readAccessToken: jest.fn(async () => 'oauth-token'),
  readCredentialsForDir: jest.fn(async () => ({ claudeAiOauth: { accessToken: 'scoped-token' } })),
  tokenFromCredentials: jest.fn(c => c?.claudeAiOauth?.accessToken || null),
  readTrustedDeviceToken: jest.fn(async () => null),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Fresh singleton per test — the service holds mirror state across calls. */
function freshService() {
  jest.resetModules();
  return require('../../src/main/services/RemoteControlService');
}

function fakeChatService() {
  const listeners = new Set();
  return {
    sessions: new Map(),
    addEventListener: jest.fn(fn => { listeners.add(fn); return () => listeners.delete(fn); }),
    sendMessage: jest.fn(),
    interrupt: jest.fn(),
    resolvePermission: jest.fn(),
    setModel: jest.fn().mockResolvedValue(undefined),
    stopTask: jest.fn().mockResolvedValue(undefined),
    // The service pushes per-session status back through ChatService's own bus.
    _send: jest.fn(),
    emit: (channel, data) => { for (const fn of listeners) fn(channel, data); },
  };
}

/** Let the queued microtasks of an attach settle (jsdom has no setImmediate). */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Turn the mirror on for `chat-1` the way a footer button click does: the
 * session already exists on ChatService, and the user asks for it explicitly.
 */
async function startMirror(service, chat, meta = {}) {
  service.attachToChatService(chat);
  chat.sessions.set('chat-1', { cwd: '/repo', ...meta });
  const result = await service.enableForSession('chat-1');
  await settle();
  return result;
}

beforeEach(() => {
  mockSettings = { claudeRemoteControlEnabled: true };
  mockHandle = makeHandle();
  mockAttachOpts = null;
  mockCreateResult = 'cse_abc123';
  mockCredsResult = { worker_jwt: 'jwt', api_base_url: 'https://api.anthropic.com', worker_epoch: 4, expires_in: 14400 };
  mockBridgeAvailable = true;
  jest.clearAllMocks();
});

afterEach(() => {
  // A test that swaps in fake timers must not leave them for the next one:
  // `settle()` waits on a real setTimeout and would never fire.
  jest.useRealTimers();
});

// ─── Opt-in gating ──────────────────────────────────────────────────────────

describe('opt-in gating', () => {
  test('refuses, with a reason, when the feature is off', async () => {
    mockSettings = {};
    const service = freshService();
    const chat = fakeChatService();
    const res = await startMirror(service, chat);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/settings/i);
    expect(mockAttachOpts).toBeNull();
    expect((await service.getStatus()).activeSessions).toBe(0);
  });

  test('refuses when managed settings forbid Remote Control', async () => {
    mockSettings = { claudeRemoteControlEnabled: true, disableRemoteControl: true };
    const service = freshService();
    const res = await startMirror(service, fakeChatService());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/organisation policy/i);
    expect(mockAttachOpts).toBeNull();
  });

  test('refuses when the SDK ships no bridge', async () => {
    mockBridgeAvailable = false;
    const service = freshService();
    const res = await startMirror(service, fakeChatService());
    expect(res.success).toBe(false);
    expect(mockAttachOpts).toBeNull();
    const status = await service.getStatus();
    expect(status.supported).toBe(false);
    expect(status.unavailableReason).toBe('stubbed out');
  });

  test('refuses a tab that has no running session yet', async () => {
    const service = freshService();
    service.attachToChatService(fakeChatService());
    const res = await service.enableForSession('chat-never-started');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/send a message/i);
    expect(mockAttachOpts).toBeNull();
  });

  test('a session starting does NOT mirror on its own', async () => {
    // The regression this whole design exists to prevent: turning the feature
    // on in settings must never put a conversation on claude.ai by itself.
    const service = freshService();
    const chat = fakeChatService();
    service.attachToChatService(chat);
    chat.sessions.set('chat-1', { cwd: '/repo' });

    // Everything a live session emits, with nobody having asked to share it.
    chat.emit('chat-message', { sessionId: 'chat-1', message: { type: 'assistant' } });
    chat.emit('chat-idle', { sessionId: 'chat-1' });
    await settle();

    expect(mockAttachOpts).toBeNull();
    expect((await service.getStatus()).activeSessions).toBe(0);
  });

  test('terminal tabs stay unconnected unless separately opted in', async () => {
    const service = freshService();
    expect(service.launchesTerminalsConnected()).toBe(false);
    mockSettings = { claudeRemoteControlEnabled: true, claudeRemoteControlTerminals: true };
    expect(service.launchesTerminalsConnected()).toBe(true);
    mockSettings.disableRemoteControl = true;
    expect(service.launchesTerminalsConnected()).toBe(false);
  });
});

// ─── Attach ─────────────────────────────────────────────────────────────────

describe('attach', () => {
  test('mints a session, attaches, and publishes metadata', async () => {
    const service = freshService();
    await startMirror(service, fakeChatService());

    expect(mockAttachOpts.sessionId).toBe('cse_abc123');
    expect(mockAttachOpts.ingressToken).toBe('jwt');
    // The mint already bumped the epoch; passing it back skips a re-register.
    expect(mockAttachOpts.epoch).toBe(4);
    expect(mockHandle.reportMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/repo', host: 'claude-terminal' }),
    );
    expect((await service.getStatus()).activeSessions).toBe(1);
  });

  test('attaches outbound-only when driving is switched off', async () => {
    mockSettings = { claudeRemoteControlEnabled: true, claudeRemoteControlDrive: false };
    const service = freshService();
    await startMirror(service, fakeChatService());
    expect(mockAttachOpts.outboundOnly).toBe(true);
  });

  test('an untrusted device produces an actionable message, not a crash', async () => {
    mockCredsResult = { terminal: true, reason: 'untrusted_device' };
    const service = freshService();
    await startMirror(service, fakeChatService());

    expect(mockAttachOpts).toBeNull();
    const status = await service.getStatus();
    expect(status.lastError).toMatch(/trusted device/i);
    expect(status.lastError).toMatch(/claude/i);
  });

  test('shows the server\'s own refusal, not just its status code', async () => {
    // What an org that forbids Remote Control actually returns.
    mockCreateResult = {
      terminal: true,
      reason: 'request_rejected',
      status: 403,
      detail: "Remote Control is disabled by your organization's policy",
    };
    const service = freshService();
    const res = await startMirror(service, fakeChatService());
    expect(res.success).toBe(false);
    expect(res.error).toBe("Remote Control is disabled by your organization's policy");
  });

  test('falls back to the status code when the server explains nothing', async () => {
    mockCreateResult = { terminal: true, reason: 'request_rejected', status: 403, detail: undefined };
    const service = freshService();
    const res = await startMirror(service, fakeChatService());
    expect(res.error).toMatch(/403/);
  });

  test('a rejected login is reported as needing a re-login', async () => {
    mockCreateResult = { terminal: false, reason: 'oauth_rejected' };
    const service = freshService();
    await startMirror(service, fakeChatService());
    expect((await service.getStatus()).lastError).toMatch(/login/i);
  });

  test('a session bound to an account uses that account credentials', async () => {
    // Both the mock and the credential module have to be resolved from the same
    // registry as the service, so the reset comes first.
    jest.resetModules();
    jest.doMock('../../src/main/services/AccountManager', () => ({
      accountConfigDir: id => `/accounts/${id}`,
    }));
    const creds = require('../../src/main/utils/claudeCredentials');
    const service = require('../../src/main/services/RemoteControlService');

    const chat = fakeChatService();
    service.attachToChatService(chat);
    chat.sessions.set('chat-1', { cwd: '/repo', accountId: 'acct-7' });
    await service.enableForSession('chat-1');
    await settle();

    expect(creds.readCredentialsForDir).toHaveBeenCalledWith('/accounts/acct-7');
    // The machine-wide login must not be what a bound session authenticates as.
    expect(creds.readAccessToken).not.toHaveBeenCalled();
  });
});

// ─── Outbound translation ───────────────────────────────────────────────────

describe('outbound', () => {
  test('forwards SDK messages verbatim', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    const message = { type: 'assistant', message: { role: 'assistant', content: [] } };
    chat.emit('chat-message', { sessionId: 'chat-1', message });
    expect(mockHandle.write).toHaveBeenCalledWith(message);
    expect(mockHandle.reportState).toHaveBeenCalledWith('running');
  });

  test('synthesises the user prompt, which the SDK stream never echoes', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    chat.emit('chat-user-message', { sessionId: 'chat-1', text: 'hello' });
    expect(mockHandle.write).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    }));
  });

  test('the mirrored prompt carries the uuid the relay needs to spot its own echo', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    chat.emit('chat-user-message', { sessionId: 'chat-1', text: 'hello', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    const written = mockHandle.write.mock.calls.find(c => c[0]?.type === 'user')[0];
    // Without it the relay fans the write back down our own inbound stream as
    // a fresh prompt, and the same message is submitted to Claude twice.
    expect(written.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(written.origin).toEqual({ kind: 'human' });
    expect(written.parent_tool_use_id).toBeNull();
  });

  test('a prompt with no uuid of its own still gets one', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    chat.emit('chat-user-message', { sessionId: 'chat-1', text: 'hello' });
    const written = mockHandle.write.mock.calls.find(c => c[0]?.type === 'user')[0];
    expect(typeof written.uuid).toBe('string');
    expect(written.uuid.length).toBeGreaterThan(0);
  });

  test('starts from the moment it is enabled, without backfilling the transcript', async () => {
    const service = freshService();
    const chat = fakeChatService();

    // Mirroring is switched on part-way through a conversation, so what was
    // already said is not replayed — claude.ai joins from here on.
    await startMirror(service, chat);
    expect(mockHandle.write).not.toHaveBeenCalled();

    chat.emit('chat-user-message', { sessionId: 'chat-1', text: 'said after enabling' });
    const userWrites = mockHandle.write.mock.calls.filter(c => c[0]?.type === 'user');
    expect(userWrites).toHaveLength(1);
    expect(userWrites[0][0].message.content[0].text).toBe('said after enabling');
  });

  test('ends the turn on idle so the remote spinner stops', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    chat.emit('chat-message', { sessionId: 'chat-1', message: { type: 'assistant' } });
    chat.emit('chat-idle', { sessionId: 'chat-1' });
    expect(mockHandle.sendResult).toHaveBeenCalled();
    expect(mockHandle.reportState).toHaveBeenLastCalledWith('idle');
  });

  test('reports state transitions once, not per streamed message', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    for (let i = 0; i < 5; i++) {
      chat.emit('chat-message', { sessionId: 'chat-1', message: { type: 'stream_event' } });
    }
    expect(mockHandle.reportState.mock.calls.filter(c => c[0] === 'running')).toHaveLength(1);
  });

  test('flushes and closes when the stream ends', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    chat.emit('chat-done', { sessionId: 'chat-1' });
    await settle();
    expect(mockHandle.flush).toHaveBeenCalled();
    expect(mockHandle.close).toHaveBeenCalled();
    expect((await service.getStatus()).activeSessions).toBe(0);
  });

  test('buffers events that arrive before the handle exists, then replays them', async () => {
    const service = freshService();
    const chat = fakeChatService();
    service.attachToChatService(chat);

    // Do not settle: the attach is still in flight.
    chat.sessions.set('chat-1', { cwd: '/repo' });
    const attaching = service.enableForSession('chat-1');
    chat.emit('chat-message', { sessionId: 'chat-1', message: { type: 'assistant', n: 1 } });
    chat.emit('chat-message', { sessionId: 'chat-1', message: { type: 'assistant', n: 2 } });
    expect(mockHandle.write).not.toHaveBeenCalled();

    await attaching;
    await settle();
    expect(mockHandle.write).toHaveBeenCalledTimes(2);
    expect(mockHandle.write.mock.calls[0][0].n).toBe(1);
    expect(mockHandle.write.mock.calls[1][0].n).toBe(2);
  });
});

// ─── Inbound translation ────────────────────────────────────────────────────

describe('inbound', () => {
  test('a prompt typed on claude.ai reaches the local session', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    mockAttachOpts.onInboundMessage({ message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } });
    expect(chat.sendMessage).toHaveBeenCalledWith('chat-1', 'ship it', [], [], expect.any(String));
  });

  test('a prompt typed on claude.ai is submitted under its own uuid', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    mockAttachOpts.onInboundMessage({
      uuid: '11111111-2222-3333-4444-555555555555',
      message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] },
    });
    expect(chat.sendMessage).toHaveBeenCalledWith('chat-1', 'ship it', [], [], '11111111-2222-3333-4444-555555555555');
  });

  test('the desktop tab is told to paint a bubble for a prompt it never composed', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    mockAttachOpts.onInboundMessage({ message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } });

    const notice = chat._send.mock.calls.find(c => c[0] === 'remote:user-message');
    expect(notice).toBeDefined();
    expect(notice[1]).toMatchObject({ sessionId: 'chat-1', text: 'ship it' });
    // Same uuid the prompt went into the session under, so the bubble's rewind
    // button points at the turn it actually started.
    expect(notice[1].uuid).toBe(chat.sendMessage.mock.calls[0][4]);
  });

  test('a send that fails leaves the tab without a bubble', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);
    chat.sendMessage.mockImplementation(() => { throw new Error('session has ended'); });

    mockAttachOpts.onInboundMessage({ message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } });

    expect(chat._send.mock.calls.some(c => c[0] === 'remote:user-message')).toBe(false);
  });

  test('an inbound prompt is not echoed back out', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    mockAttachOpts.onInboundMessage({ message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } });
    // ChatService answers every send with this event, local or remote.
    chat.emit('chat-user-message', { sessionId: 'chat-1', text: 'ship it' });

    const userWrites = mockHandle.write.mock.calls.filter(c => c[0]?.type === 'user');
    expect(userWrites).toHaveLength(0);
  });

  test('a locally typed prompt is still mirrored after an inbound one', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    mockAttachOpts.onInboundMessage({ message: { role: 'user', content: [{ type: 'text', text: 'from phone' }] } });
    chat.emit('chat-user-message', { sessionId: 'chat-1', text: 'from phone' });
    chat.emit('chat-user-message', { sessionId: 'chat-1', text: 'from desktop' });

    const userWrites = mockHandle.write.mock.calls.filter(c => c[0]?.type === 'user');
    expect(userWrites).toHaveLength(1);
    expect(userWrites[0][0].message.content[0].text).toBe('from desktop');
  });

  test('interrupt is forwarded', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);
    mockAttachOpts.onInterrupt();
    expect(chat.interrupt).toHaveBeenCalledWith('chat-1');
  });

  test('a read-only mirror refuses to drive the session', async () => {
    mockSettings = { claudeRemoteControlEnabled: true, claudeRemoteControlDrive: false };
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    mockAttachOpts.onInboundMessage({ message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } });
    mockAttachOpts.onInterrupt();
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(chat.interrupt).not.toHaveBeenCalled();
  });
});

// ─── Permissions ────────────────────────────────────────────────────────────

describe('permissions', () => {
  const request = { sessionId: 'chat-1', requestId: 'perm-1', toolName: 'Bash', input: { command: 'ls' } };

  test('a prompt is forwarded and marks the session as needing action', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    chat.emit('chat-permission-request', request);
    expect(mockHandle.reportState).toHaveBeenLastCalledWith('requires_action');
    expect(mockHandle.sendControlRequest).toHaveBeenCalledWith(expect.objectContaining({
      type: 'control_request',
      request_id: 'perm-1',
      request: expect.objectContaining({ subtype: 'can_use_tool', tool_name: 'Bash' }),
    }));
  });

  test('answering on claude.ai resolves the local prompt', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);
    chat.emit('chat-permission-request', request);

    mockAttachOpts.onPermissionResponse({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'perm-1', response: { behavior: 'allow', updatedInput: { command: 'ls' } } },
    });
    expect(chat.resolvePermission).toHaveBeenCalledWith('perm-1', {
      behavior: 'allow', updatedInput: { command: 'ls' },
    });
  });

  test('answering on the desktop retracts the remote prompt', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);
    chat.emit('chat-permission-request', request);
    chat.emit('chat-permission-resolved', { sessionId: 'chat-1', requestId: 'perm-1' });

    expect(mockHandle.sendControlCancelRequest).toHaveBeenCalledWith('perm-1');
  });

  test('a second answer after the first is ignored', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);
    chat.emit('chat-permission-request', request);
    chat.emit('chat-permission-resolved', { sessionId: 'chat-1', requestId: 'perm-1' });

    const verdict = mockAttachOpts.onPermissionResponse({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'perm-1', response: { behavior: 'allow' } },
    });
    expect(verdict).toBe(false);
    expect(chat.resolvePermission).not.toHaveBeenCalled();
  });

  test('an unparseable response is rejected so the prompt can be re-delivered', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);
    chat.emit('chat-permission-request', request);

    expect(mockAttachOpts.onPermissionResponse({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'perm-1', response: { behavior: 'maybe' } },
    })).toBe(false);
    expect(mockAttachOpts.onPermissionResponse({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'perm-1', error: 'nope' },
    })).toBe(false);
    expect(chat.resolvePermission).not.toHaveBeenCalled();
  });
});

// ─── Per-session control ────────────────────────────────────────────────────

describe('per-session control', () => {
  test('disabling one session stops only that mirror', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);
    expect((await service.getStatus()).activeSessions).toBe(1);

    const res = service.disableForSession('chat-1');
    expect(res.success).toBe(true);
    await settle();
    expect(mockHandle.close).toHaveBeenCalled();
    expect((await service.getStatus()).activeSessions).toBe(0);
  });

  test('disabling something never mirrored is a no-op, not an error', async () => {
    const service = freshService();
    service.attachToChatService(fakeChatService());
    expect(service.disableForSession('chat-unknown').success).toBe(true);
  });

  test('enabling twice does not attach twice', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);
    const again = await service.enableForSession('chat-1');
    expect(again.success).toBe(true);
    expect((await service.getStatus()).activeSessions).toBe(1);
  });

  test('reports a session status the tab can paint from', async () => {
    const service = freshService();
    const chat = fakeChatService();
    expect(service.getSessionStatus('chat-1').mirrored).toBe(false);
    await startMirror(service, chat);
    expect(service.getSessionStatus('chat-1').mirrored).toBe(true);
    service.disableForSession('chat-1');
    expect(service.getSessionStatus('chat-1').mirrored).toBe(false);
  });

  test('pushes status to the tab on attach and on teardown', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    const pushed = chat._send.mock.calls.filter(c => c[0] === 'remote-control:session-status-changed');
    expect(pushed.at(-1)[1]).toEqual({ sessionId: 'chat-1', mirrored: true, lastError: null });

    service.disableForSession('chat-1');
    const after = chat._send.mock.calls.filter(c => c[0] === 'remote-control:session-status-changed');
    expect(after.at(-1)[1]).toEqual({ sessionId: 'chat-1', mirrored: false, lastError: null });
  });

  test('lists what is shared, for the Connectivity screen', async () => {
    const service = freshService();
    const chat = fakeChatService();
    chat.sessions.set('chat-1', { cwd: '/repo', projectId: 'proj-1' });
    service.attachToChatService(chat);
    await service.enableForSession('chat-1');
    await settle();

    const [row] = service.listSessions();
    expect(row).toMatchObject({
      sessionId: 'chat-1',
      ccrSessionId: 'cse_abc123',
      cwd: '/repo',
      projectId: 'proj-1',
      state: 'idle',
    });
    expect(typeof row.startedAt).toBe('number');
  });

  test('a session still building its transport is not listed as reachable', async () => {
    const service = freshService();
    const chat = fakeChatService();
    service.attachToChatService(chat);
    chat.sessions.set('chat-1', { cwd: '/repo' });

    // Attach in flight: claude.ai does not have it yet, so offering it would
    // send the user to a session that is not there.
    const attaching = service.enableForSession('chat-1');
    expect(service.listSessions()).toHaveLength(0);

    await attaching;
    await settle();
    expect(service.listSessions()).toHaveLength(1);
  });

  test('pushes the reason when an attach fails', async () => {
    mockCredsResult = { terminal: true, reason: 'untrusted_device' };
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    const pushed = chat._send.mock.calls.filter(c => c[0] === 'remote-control:session-status-changed');
    expect(pushed.at(-1)[1].mirrored).toBe(false);
    expect(pushed.at(-1)[1].lastError).toMatch(/trusted device/i);
  });
});

// ─── Transport lifecycle ────────────────────────────────────────────────────

describe('transport lifecycle', () => {
  test('a superseded epoch is not retried', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    mockAttachOpts.onClose(4090);
    await settle();
    expect(mockHandle.reconnectTransport).not.toHaveBeenCalled();
    expect((await service.getStatus()).activeSessions).toBe(0);
  });

  test('an expired credential re-mints and reconnects with the new epoch', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    // Fake timers only from here: startMirror above waits on a real one.
    jest.useFakeTimers();
    mockCredsResult = { worker_jwt: 'jwt-2', api_base_url: 'https://api.anthropic.com', worker_epoch: 9 };
    mockAttachOpts.onClose(401);
    await jest.advanceTimersByTimeAsync(5000);

    expect(mockHandle.reconnectTransport).toHaveBeenCalledWith(
      expect.objectContaining({ ingressToken: 'jwt-2', epoch: 9 }),
    );
  });

  test('switching account drops every mirror', async () => {
    const service = freshService();
    const chat = fakeChatService();
    await startMirror(service, chat);

    service.onAccountChanged();
    await settle();
    expect(mockHandle.close).toHaveBeenCalled();
    expect((await service.getStatus()).activeSessions).toBe(0);
  });

  test('subscribing twice does not double-write', async () => {
    const service = freshService();
    const chat = fakeChatService();
    service.attachToChatService(chat);
    service.attachToChatService(chat);
    chat.sessions.set('chat-1', { cwd: '/repo' });
    await service.enableForSession('chat-1');
    await settle();

    chat.emit('chat-message', { sessionId: 'chat-1', message: { type: 'assistant' } });
    expect(mockHandle.write).toHaveBeenCalledTimes(1);
  });
});
