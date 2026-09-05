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

  test('makes the screen the output channel, not prose', () => {
    const { append } = voice();

    expect(append).toContain('Voice Session');
    expect(append).toMatch(/action is the answer/i);
    expect(append).toMatch(/act, never narrate/i);
  });

  test('routes even questions to a visible chat tab', () => {
    const { append } = voice();

    // "où en est le bug ninin" must land on screen, not in spoken prose.
    expect(append).toMatch(/questions too/i);
    expect(append).toMatch(/session_search/);
  });

  test('reserves text for ambiguity and failure only', () => {
    const { append } = voice();

    expect(append).toMatch(/only when acting is impossible/i);
    expect(append).toMatch(/one short sentence/i);
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

  test('spells out the dispatch model instead of refusing work', () => {
    const { append } = voice();

    expect(append).toContain('tab_send');
    expect(append).toContain('terminal_create');
    expect(append).toMatch(/dispatch/i);
    // It must not tell the user to go back to the keyboard — that was the old,
    // read-only design.
    expect(append).not.toMatch(/needs the keyboard/i);
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

  test('can dispatch work to a normal chat tab', () => {
    for (const tool of [
      'mcp__claude-terminal__tab_list',
      'mcp__claude-terminal__tab_send',
      'mcp__claude-terminal__tab_status',
      'mcp__claude-terminal__terminal_create',
    ]) {
      expect(VOICE_SAFE_TOOLS).toContain(tool);
    }
  });

  test('never touches the machine directly', () => {
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'KillShell', 'BashOutput']) {
      expect(VOICE_SAFE_TOOLS).not.toContain(tool);
    }
  });

  test('excludes terminal_send_command, the one unsupervised dispatch path', () => {
    // tab_send goes to a Claude session that gates destructive tools behind a
    // permission prompt. terminal_send_command writes straight to a PTY: raw
    // shell, no gate, nothing to interrupt.
    expect(VOICE_SAFE_TOOLS).not.toContain('mcp__claude-terminal__terminal_send_command');
  });

  test('withholds MCP tools that mutate state on their own', () => {
    const forbidden = [
      'project_delete', 'project_update', 'project_create',
      'quickaction_add', 'quickaction_update', 'quickaction_delete',
      'settings_set', 'sidebar_set_pinned',
      'kanban_add_task', 'kanban_delete_task', 'kanban_move_task',
      'workflow_delete', 'workflow_trigger', 'workflow_update_node',
      'automation_create', 'automation_delete', 'automation_enable',
      'parallel_start_run', 'parallel_merge_run', 'parallel_cleanup_run',
      'db_query', 'db_remove_connection',
      'knowledge_write', 'knowledge_delete',
      'workspace_write_doc',
      'plugin_install', 'plugin_uninstall',
      'marketplace_install', 'marketplace_uninstall',
      'tab_close', 'terminal_close', 'control_tower_interrupt',
    ];

    for (const tool of forbidden) {
      expect(VOICE_SAFE_TOOLS).not.toContain(`mcp__claude-terminal__${tool}`);
    }
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
