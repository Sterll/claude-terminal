// The chat's local /mcp command: retrying MCP servers inside a live session.
//
// The CLI never retries a server that drops mid-session, and its own /mcp
// refuses to reconnect under the SDK, so a claude.ai connector re-authorized
// mid-conversation stayed in needs-auth until the tab was reopened.

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

const SESSION = 'chat-mcp-test';

/**
 * A query stream answering the two MCP control requests the way the CLI does:
 * a reconnect succeeds when the server is reachable now, and otherwise throws
 * with the status the server is left in.
 */
function fakeQueryStream(statuses, reachable = []) {
  const servers = new Map(Object.entries(statuses));
  const calls = [];
  return {
    calls,
    servers,
    mcpServerStatus: async () => [...servers].map(([name, status]) => ({ name, status })),
    reconnectMcpServer: async (name) => {
      calls.push(name);
      if (reachable.includes(name)) {
        servers.set(name, 'connected');
        return;
      }
      throw new Error(`Server status: ${servers.get(name)}`);
    },
  };
}

function startSession(queryStream, extra = {}) {
  const session = { queryStream, ...extra };
  chatService.sessions.set(SESSION, session);
  return session;
}

afterEach(() => {
  chatService.sessions.delete(SESSION);
});

describe('ChatService.reconnectMcpServers', () => {
  test('a bare /mcp retries only the servers this conversation lost', async () => {
    // Linear was up and dropped; Bird is one of the dozens of connectors a
    // Team account lists without ever having authorized them. The CLI handles
    // reconnects one at a time, so retrying those too costs a second each.
    const qs = fakeQueryStream({
      'claude.ai Linear': 'needs-auth',
      'claude.ai Bird': 'needs-auth',
      'claude.ai Slack': 'connected',
    }, ['claude.ai Linear']);
    startSession(qs, { mcpSeenConnected: new Set(['claude.ai Linear', 'claude.ai Slack']) });

    const res = await chatService.reconnectMcpServers(SESSION);

    expect(qs.calls).toEqual(['claude.ai Linear']);
    expect(res.results).toEqual([{ name: 'claude.ai Linear', ok: true }]);
    expect(res.notConnected).toEqual(['claude.ai Bird']);
  });

  test('a name matches case-insensitively, connected servers included', async () => {
    const qs = fakeQueryStream({
      'claude.ai Linear': 'connected',
      'plugin:quill:linear': 'needs-auth',
      'claude.ai Notion': 'needs-auth',
      'linear-disabled': 'disabled',
    }, ['claude.ai Linear', 'plugin:quill:linear']);
    startSession(qs);

    const res = await chatService.reconnectMcpServers(SESSION, 'LINEAR');

    expect(qs.calls).toEqual(['claude.ai Linear', 'plugin:quill:linear']);
    expect(res.results.every(r => r.ok)).toBe(true);
  });

  test('`all` retries every server that is down, and reports each outcome', async () => {
    const qs = fakeQueryStream({
      'claude.ai Linear': 'needs-auth',
      'claude.ai Bird': 'needs-auth',
      'claude.ai Figma': 'failed',
      'claude.ai Slack': 'connected',
      'claude.ai Off': 'disabled',
    }, ['claude.ai Bird']);
    startSession(qs);

    const res = await chatService.reconnectMcpServers(SESSION, 'all');

    expect(qs.calls).toEqual(['claude.ai Linear', 'claude.ai Bird', 'claude.ai Figma']);
    expect(res.results).toEqual([
      { name: 'claude.ai Linear', ok: false, error: 'Server status: needs-auth' },
      { name: 'claude.ai Bird', ok: true },
      { name: 'claude.ai Figma', ok: false, error: 'Server status: failed' },
    ]);
    expect(res.notConnected).toEqual(['claude.ai Linear', 'claude.ai Figma']);
  });

  test('a server brought back by name is retried by the next bare /mcp', async () => {
    const qs = fakeQueryStream({ 'claude.ai Edges': 'needs-auth' }, ['claude.ai Edges']);
    const session = startSession(qs);

    await chatService.reconnectMcpServers(SESSION, 'edges');
    qs.servers.set('claude.ai Edges', 'needs-auth');
    await chatService.reconnectMcpServers(SESSION);

    expect(qs.calls).toEqual(['claude.ai Edges', 'claude.ai Edges']);
    expect(session.mcpSeenConnected.has('claude.ai Edges')).toBe(true);
  });

  test('refuses without a live local session', async () => {
    await expect(chatService.reconnectMcpServers('chat-none')).rejects.toThrow('No live session');
    startSession(fakeQueryStream({}), { isCloud: true });
    await expect(chatService.reconnectMcpServers(SESSION)).rejects.toThrow('No live session');
  });
});

describe('ChatService remembers connected MCP servers at each turn end', () => {
  let originalSend;
  let originalLifecycle;

  beforeEach(() => {
    originalSend = chatService._send;
    originalLifecycle = chatService._emitLifecycle;
    chatService._send = () => {};
    chatService._emitLifecycle = () => {};
  });

  afterEach(() => {
    chatService._send = originalSend;
    chatService._emitLifecycle = originalLifecycle;
  });

  test('a server seen connected at a turn end is one a bare /mcp will retry', async () => {
    const qs = fakeQueryStream({ 'claude.ai Linear': 'connected', 'claude.ai Bird': 'needs-auth' });
    const session = startSession(qs);

    async function* stream() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } };
      yield { type: 'result', subtype: 'success' };
    }
    await chatService._processStream(SESSION, stream());
    await new Promise(resolve => setTimeout(resolve, 0));

    expect([...session.mcpSeenConnected]).toEqual(['claude.ai Linear']);
  });
});
