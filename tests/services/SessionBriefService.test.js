/**
 * SessionBriefService: the "where was I" brief of a conversation. What it must
 * get right: send the model what matters and not the tool output, call it only
 * when there is something new, and on an update send only what came after the
 * previous brief.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SessionBriefService, condenseTranscript, parseBrief, cursorOf, messagesSince, countMessages,
} = require('../../src/main/services/SessionBriefService');

const user = (text, uuid) => ({ role: 'user', text, ...(uuid ? { uuid } : {}) });
const said = (text, uuid) => ({ role: 'assistant', type: 'text', text, ...(uuid ? { uuid } : {}) });
const tool = (toolName, toolInput = {}) => ({ role: 'assistant', type: 'tool_use', toolName, toolInput, toolUseId: `t-${Math.random()}` });
const result = (output, extra = {}) => ({ role: 'tool_result', toolUseId: 'x', output, ...extra });

const BRIEF = { about: 'Fix the tab drag freeze.', status: 'Done, PR to open.', decisions: ['Read before write, because layout'], notes: [] };
const reply = (brief = BRIEF) => `\`\`\`json\n${JSON.stringify(brief)}\n\`\`\``;

describe('condenseTranscript', () => {
  test('keeps what was said, one line per tool call, and drops tool output and thinking', () => {
    const text = condenseTranscript([
      user('Fix the drag freeze', 'u1'),
      { role: 'assistant', type: 'thinking', text: 'SECRET THOUGHTS' },
      tool('Edit', { file_path: 'src/ProjectBar.js' }),
      result('HUGE TOOL OUTPUT'),
      tool('Bash', { command: 'npm test' }),
      said('Fixed: measure before writing.', 'a1'),
    ]);
    expect(text).toContain('User: Fix the drag freeze');
    expect(text).toContain('· Edit src/ProjectBar.js');
    expect(text).toContain('· Bash npm test');
    expect(text).toContain('Claude: Fixed: measure before writing.');
    expect(text).not.toContain('HUGE TOOL OUTPUT');
    expect(text).not.toContain('SECRET THOUGHTS');
  });

  test("the user's answers to Claude's questions and approved plans are kept, they are decisions", () => {
    const text = condenseTranscript([
      tool('AskUserQuestion', { questions: [] }),
      result('', { answers: { 'Where does the brief live?': 'Right drawer' } }),
      tool('ExitPlanMode', { plan: 'Step 1: add a drawer' }),
    ]);
    expect(text).toContain('User answered "Where does the brief live?": Right drawer');
    expect(text).toContain('Claude proposed a plan: Step 1: add a drawer');
    expect(text).not.toContain('AskUserQuestion');
  });

  test('a long run of tool calls is capped', () => {
    const calls = Array.from({ length: 20 }, (_, i) => tool('Read', { file_path: `f${i}.js` }));
    const text = condenseTranscript([user('go'), ...calls, said('done')]);
    expect(text).toContain('· Read f11.js');
    expect(text).not.toContain('· Read f12.js');
    expect(text).toContain('8 more tool calls');
  });

  test('over budget, tool runs collapse to counts and the middle is elided, never the ends', () => {
    const messages = [user('THE OPENING GOAL')];
    for (let i = 0; i < 200; i++) {
      messages.push(tool('Edit', { file_path: `f${i}.js` }), said(`step ${i} ${'x'.repeat(200)}`));
    }
    messages.push(said('THE CURRENT STATE'));
    const text = condenseTranscript(messages, { budget: 8000 });
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(text).toContain('THE OPENING GOAL');
    expect(text).toContain('THE CURRENT STATE');
    expect(text).toMatch(/lines omitted/);
    expect(text).toContain('1 tool call: Edit');
  });
});

describe('parseBrief', () => {
  test('reads JSON inside a fence or after a preamble', () => {
    expect(parseBrief(reply())).toEqual(BRIEF);
    expect(parseBrief(`Here it is: ${JSON.stringify(BRIEF)}`)).toEqual(BRIEF);
  });

  test('anything that is not a brief is null', () => {
    expect(parseBrief(null)).toBeNull();
    expect(parseBrief('I cannot do that')).toBeNull();
    expect(parseBrief('{"about": ')).toBeNull();
    expect(parseBrief('{"decisions": ["x"]}')).toBeNull();
  });

  test('keeps strings only and replaces the em dash', () => {
    const brief = parseBrief(JSON.stringify({ about: 'A — B', status: 'ok', decisions: ['x', 3, ''], notes: 'nope' }));
    expect(brief).toEqual({ about: 'A - B', status: 'ok', decisions: ['x'], notes: [] });
  });
});

describe('cursor', () => {
  const messages = [user('a', 'u1'), said('b', 'a1'), tool('Read'), result('r')];

  test('points at the last uuid and counts what follows it', () => {
    expect(cursorOf(messages)).toEqual({ uuid: 'a1', after: 2 });
    expect(messagesSince(messages, cursorOf(messages))).toEqual([]);
  });

  test('what came after is found again once the transcript grew', () => {
    const grown = [...messages, user('c', 'u2'), said('d', 'a2')];
    expect(countMessages(messagesSince(grown, cursorOf(messages)))).toBe(2);
  });

  test('a cursor no longer in the transcript reads as lost', () => {
    expect(messagesSince([user('other', 'u9')], { uuid: 'a1', after: 0 })).toBeNull();
  });
});

describe('SessionBriefService', () => {
  let dir;
  let transcript;
  let runPrompt;
  let service;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-brief-'));
    transcript = [user('Fix the drag freeze', 'u1'), tool('Edit', { file_path: 'src/ProjectBar.js' }), said('Fixed.', 'a1')];
    runPrompt = jest.fn(async () => reply());
    service = new SessionBriefService({
      loadMessages: async () => transcript,
      runPrompt,
      dir,
      now: () => 1000,
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const params = { projectPath: '/p', sessionId: 'sess-1', language: 'fr' };

  test('status before any brief: nothing cached, every message is new, and no model call', async () => {
    const status = await service.status(params);
    expect(status).toMatchObject({ success: true, brief: null, newMessages: 2 });
    expect(runPrompt).not.toHaveBeenCalled();
  });

  test('the first brief reads the whole session, in the language asked, and is cached', async () => {
    const res = await service.generate(params);
    expect(res).toMatchObject({ success: true, brief: BRIEF, newMessages: 0, generatedAt: 1000, language: 'fr' });
    expect(runPrompt).toHaveBeenCalledTimes(1);
    const { prompt, systemPrompt } = runPrompt.mock.calls[0][0];
    expect(prompt).toContain('<transcript>');
    expect(prompt).toContain('User: Fix the drag freeze');
    expect(prompt).toContain('in French');
    expect(systemPrompt).toContain('"decisions"');

    const status = await service.status(params);
    expect(status).toMatchObject({ brief: BRIEF, newMessages: 0, generatedAt: 1000 });
  });

  test('nothing new since the last brief: no model call', async () => {
    await service.generate(params);
    const again = await service.generate(params);
    expect(again).toMatchObject({ success: true, brief: BRIEF });
    expect(runPrompt).toHaveBeenCalledTimes(1);
  });

  test('an update sends the previous brief and only what came after it', async () => {
    await service.generate(params);
    transcript = [...transcript, user('Now the sidebar too', 'u2'), said('Same shape.', 'a2')];
    expect((await service.status(params)).newMessages).toBe(2);

    await service.generate(params);
    const { prompt } = runPrompt.mock.calls[1][0];
    expect(prompt).toContain('<previous_brief>');
    expect(prompt).toContain(BRIEF.about);
    expect(prompt).toContain('User: Now the sidebar too');
    expect(prompt).not.toContain('Fix the drag freeze');
  });

  test('a transcript rewritten under the cursor is read in full again', async () => {
    await service.generate(params);
    transcript = [user('A different start', 'z1'), said('ok', 'z2')];
    await service.generate(params);
    const { prompt } = runPrompt.mock.calls[1][0];
    expect(prompt).toContain('<transcript>');
    expect(prompt).toContain('A different start');
  });

  test('a brief in another language is rewritten even with nothing new', async () => {
    await service.generate(params);
    await service.generate({ ...params, language: 'en' });
    expect(runPrompt).toHaveBeenCalledTimes(2);
    expect(runPrompt.mock.calls[1][0].prompt).toContain('in English');
  });

  test('a double click is one model call', async () => {
    const [a, b] = await Promise.all([service.generate(params), service.generate(params)]);
    expect(a).toBe(b);
    expect(runPrompt).toHaveBeenCalledTimes(1);
  });

  test('a reply that is not a brief fails without caching anything', async () => {
    runPrompt.mockResolvedValueOnce('Sorry, I cannot help with that.');
    expect(await service.generate(params)).toEqual({ success: false, error: 'failed' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('an empty session is not sent to the model', async () => {
    transcript = [];
    expect(await service.generate(params)).toEqual({ success: false, error: 'empty' });
    expect(runPrompt).not.toHaveBeenCalled();
  });

  test('a session id that is not one never reaches the filesystem', async () => {
    await expect(service.generate({ ...params, sessionId: '../../settings' })).rejects.toThrow('Invalid session id');
  });

  test('an unreadable cache reads as no brief, it is regenerable', async () => {
    fs.writeFileSync(path.join(dir, 'sess-1.json'), '{"brief": ');
    expect(await service.status(params)).toMatchObject({ success: true, brief: null });
  });
});
