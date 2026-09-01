/**
 * Voice session profile: terse system prompt + read-only toolset.
 *
 * The design constraint being pinned here: a hands-free session must never
 * reach a tool that raises a permission prompt, because the user is in a
 * fullscreen game and cannot click it. The fix is a narrow toolset, never a
 * looser permissionMode — these tests exist to stop that shortcut being taken
 * later.
 */

const {
  getBuiltinSystemPrompt,
  VOICE_SAFE_TOOLS,
} = require('../../src/renderer/services/BuiltinSystemPrompts');

describe('voice system prompt', () => {
  const voice = () => getBuiltinSystemPrompt('general', { voice: true });

  test('still returns a valid preset prompt', () => {
    const prompt = voice();

    expect(prompt.type).toBe('preset');
    expect(prompt.preset).toBe('claude_code');
    expect(typeof prompt.append).toBe('string');
  });

  test('asks for short spoken answers', () => {
    const { append } = voice();

    expect(append).toContain('Voice Session');
    expect(append).toMatch(/one or two sentences/i);
  });

  test('drops the rich markdown guidance, which is the opposite of what voice needs', () => {
    const { append } = voice();
    const normal = getBuiltinSystemPrompt('general').append;

    expect(normal).toMatch(/discord-embed/i);
    expect(append).not.toMatch(/discord-embed/i);
    expect(append.length).toBeLessThan(normal.length);
  });

  test('keeps the shared Claude Terminal context', () => {
    const { append } = voice();

    expect(append).toMatch(/Claude Terminal/);
  });

  test('tells the model to move the screen rather than describe it', () => {
    expect(voice().append).toContain('ui_navigate');
  });

  test('warns that spoken names arrive mangled', () => {
    expect(voice().append).toMatch(/marvel[- ]quiz/i);
  });

  test('project type appends are not carried into voice mode', () => {
    const fivem = getBuiltinSystemPrompt('fivem', { voice: true }).append;

    expect(fivem).not.toMatch(/FiveM-Specific/i);
  });

  test('normal mode is untouched by the new option', () => {
    const a = getBuiltinSystemPrompt('webapp');
    const b = getBuiltinSystemPrompt('webapp', {});

    expect(a.append).toBe(b.append);
    expect(a.append).toMatch(/webapp|Web App/i);
  });
});

describe('voice-safe toolset', () => {
  test('exposes what a status question needs', () => {
    for (const tool of [
      'mcp__claude-terminal__session_search',
      'mcp__claude-terminal__session_recap',
      'mcp__claude-terminal__ui_navigate',
      'mcp__claude-terminal__ui_state',
      'mcp__claude-terminal__project_open',
      'Read',
      'Grep',
    ]) {
      expect(VOICE_SAFE_TOOLS).toContain(tool);
    }
  });

  test('withholds every tool that could act on the machine', () => {
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'KillShell']) {
      expect(VOICE_SAFE_TOOLS).not.toContain(tool);
    }
  });

  test('withholds mutating MCP tools', () => {
    const mutators = VOICE_SAFE_TOOLS.filter(t =>
      /_(create|delete|update|add|set|run|send|close|install|uninstall|write|merge|cancel|trigger|enable)$/.test(t)
    );

    expect(mutators).toEqual([]);
  });

  test('is a flat list of unique non-empty strings', () => {
    expect(VOICE_SAFE_TOOLS.length).toBeGreaterThan(5);
    expect(new Set(VOICE_SAFE_TOOLS).size).toBe(VOICE_SAFE_TOOLS.length);
    for (const tool of VOICE_SAFE_TOOLS) {
      expect(typeof tool).toBe('string');
      expect(tool.trim()).toBe(tool);
      expect(tool.length).toBeGreaterThan(0);
    }
  });
});
