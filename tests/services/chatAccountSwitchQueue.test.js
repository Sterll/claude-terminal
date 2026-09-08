/**
 * A message sent while the account-switch offer is up must survive the switch.
 *
 * The offer leaves the session running, so the composer stays usable: what the
 * user types next goes into the live queue and waits its turn. The switch then
 * aborts that process, and the resume that follows only brings back what the
 * CLI wrote down — which is everything except the message that never got its
 * turn. It used to disappear there, silently, which reads as the whole
 * conversation having failed to resume.
 *
 * So: whatever is still unanswered when the switch happens comes back out of
 * `prepareSwitchAccount`, and anything already answered does not (sending that
 * again would post it twice).
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

const SID = 'chat-switch-1';

/** Enough of a session for sendMessage / closeSession to run against. */
function openSession(extra = {}) {
  const pushed = [];
  chatService.sessions.set(SID, {
    cwd: '/work/project', projectId: 'p1', accountId: 'acc-max',
    messageQueue: { push: msg => pushed.push(msg), close: () => {} },
    ...extra,
  });
  return pushed;
}

// Own properties shadowing the prototype rather than jest.spyOn, which refuses
// a method the object does not have: `_emitEvent` is one the fork adds and
// upstream does not, and this suite has to run on both.
const stubs = {
  _send: () => {},
  _emitEvent: () => {},
  _emitMessage: () => {},
  _flushDeltas: () => {},
};

beforeEach(() => Object.assign(chatService, stubs));
afterEach(() => {
  for (const key of Object.keys(stubs)) delete chatService[key];
  chatService.sessions.delete(SID);
});

describe('account switch with a message still in flight', () => {
  test('hands back the message that never got its turn', () => {
    openSession();
    chatService.sendMessage(SID, 'and now the tests', [], [], 'uuid-1');

    const ctx = chatService.prepareSwitchAccount(SID);

    expect(ctx.pendingUserMessages).toHaveLength(1);
    expect(ctx.pendingUserMessages[0]).toMatchObject({
      text: 'and now the tests', userMessageUuid: 'uuid-1',
    });
  });

  test('carries its images and mentions along', () => {
    openSession();
    const images = [{ base64: 'aGk=', mediaType: 'image/png' }];
    const mentions = [{ label: 'README.md', content: '# hi' }];
    chatService.sendMessage(SID, 'look at this', images, mentions, 'uuid-2');

    const ctx = chatService.prepareSwitchAccount(SID);

    expect(ctx.pendingUserMessages[0].images).toEqual(images);
    expect(ctx.pendingUserMessages[0].mentions).toEqual(mentions);
  });

  // The CLI stamps the prompt's uuid on the turn's first reply frame. That is
  // the acknowledgement that it has been written down, and it is what a usage
  // limit refused mid-turn never gets to a result for.
  test('drops a message the CLI acknowledged by uuid', async () => {
    openSession();
    chatService.sendMessage(SID, 'answered already', [], [], 'uuid-3');
    await chatService._processStream(SID, (async function* () {
      yield { type: 'assistant', user_message_uuid: 'uuid-3', message: { role: 'assistant', content: [] } };
    })());

    expect(chatService.prepareSwitchAccount(SID).pendingUserMessages).toEqual([]);
  });

  test('drops every member of an acknowledged batch', async () => {
    openSession();
    chatService.sendMessage(SID, 'first', [], [], 'uuid-a');
    chatService.sendMessage(SID, 'second', [], [], 'uuid-b');
    await chatService._processStream(SID, (async function* () {
      yield {
        type: 'assistant', user_message_uuid: 'uuid-b',
        user_message_uuids: ['uuid-a', 'uuid-b'],
        message: { role: 'assistant', content: [] },
      };
    })());

    expect(chatService.prepareSwitchAccount(SID).pendingUserMessages).toEqual([]);
  });

  // The bug this file exists for, in its original form: the limit throws, so no
  // result ever arrives, and the message that caused it used to survive as
  // pending — then get replayed on top of a resume that already held it.
  test('does not hand back a message the CLI answered before the stream died', async () => {
    openSession();
    chatService.sendMessage(SID, 'refais le tri', [], [], 'uuid-5');
    await chatService._processStream(SID, (async function* () {
      yield { type: 'assistant', user_message_uuid: 'uuid-5', message: { role: 'assistant', content: [] } };
      throw new Error('Claude Code process exited with code 1');
    })());

    expect(chatService.prepareSwitchAccount(SID).pendingUserMessages).toEqual([]);
  });

  // Two follow-ups typed while the offer is on screen: the second used to
  // overwrite the first, which then vanished without a trace.
  test('keeps both messages when two are queued', () => {
    openSession();
    chatService.sendMessage(SID, 'first', [], [], 'uuid-x');
    chatService.sendMessage(SID, 'second', [], [], 'uuid-y');

    expect(chatService.prepareSwitchAccount(SID).pendingUserMessages.map(m => m.text))
      .toEqual(['first', 'second']);
  });

  // A message queued behind the turn that just closed has not been written
  // down, so a result must not clear it on a session that stamps uuids.
  test('a result does not clear a message the turn never consumed', async () => {
    openSession();
    chatService.sendMessage(SID, 'turn A', [], [], 'uuid-A');
    chatService.sendMessage(SID, 'turn B', [], [], 'uuid-B');
    await chatService._processStream(SID, (async function* () {
      yield { type: 'assistant', user_message_uuid: 'uuid-A', message: { role: 'assistant', content: [] } };
      yield { type: 'result', subtype: 'success', is_error: false };
    })());

    expect(chatService.prepareSwitchAccount(SID).pendingUserMessages.map(m => m.text))
      .toEqual(['turn B']);
  });

  // An older producer stamps nothing, so a closed turn is all it gives us.
  test('falls back to the result when the producer stamps no uuid', async () => {
    openSession();
    chatService.sendMessage(SID, 'answered already', [], [], 'uuid-6');
    await chatService._processStream(SID, (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false };
    })());

    expect(chatService.prepareSwitchAccount(SID).pendingUserMessages).toEqual([]);
  });

  // An error result is still an answer: the renderer showed it and the CLI
  // recorded the turn, so resending would post the message twice.
  test('hands back nothing when the turn ended on an error result', async () => {
    openSession();
    chatService.sendMessage(SID, 'answered with an error', [], [], 'uuid-4');
    await chatService._processStream(SID, (async function* () {
      yield { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['nope'] };
    })());

    const ctx = chatService.prepareSwitchAccount(SID);

    expect(ctx.pendingUserMessages).toEqual([]);
  });

  test('hands back nothing when nothing was ever sent', () => {
    openSession();
    expect(chatService.prepareSwitchAccount(SID).pendingUserMessages).toEqual([]);
  });

  test('still carries the context the restart is spawned with', () => {
    openSession();
    expect(chatService.prepareSwitchAccount(SID)).toMatchObject({
      cwd: '/work/project', projectId: 'p1', accountId: 'acc-max',
    });
  });

  test('closes the session either way', () => {
    openSession();
    chatService.sendMessage(SID, 'in flight', [], [], 'uuid-5');
    chatService.prepareSwitchAccount(SID);
    expect(chatService.sessions.has(SID)).toBe(false);
  });
});
