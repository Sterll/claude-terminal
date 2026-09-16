/**
 * The em dash ban shipped in the system prompt.
 *
 * Two halves, and the second is the one that kept failing in practice: the
 * rule has to be present on every path, and the prompt around it has to obey
 * it. GLOBAL_APPEND and RICH_MARKDOWN_APPEND are ~600 lines of the model's
 * immediate context, so a prompt written in em dashes is a louder style
 * example than one line telling it not to - the rule shipped in March and the
 * dashes kept coming until the prompt itself was cleaned.
 */

const path = require('path');
const fs = require('fs');

const { getBuiltinSystemPrompt } = require('../../src/renderer/services/BuiltinSystemPrompts');

const EM_DASH = '—';
const EN_DASH = '–';

describe('em dash rule', () => {
  const paths = [
    ['rich', getBuiltinSystemPrompt('general')],
    ['webapp', getBuiltinSystemPrompt('webapp')],
    ['fivem', getBuiltinSystemPrompt('fivem')],
    ['discord', getBuiltinSystemPrompt('discord')],
    ['voice', getBuiltinSystemPrompt('general', { voice: true })],
  ];

  test.each(paths)('%s sessions are told not to use it', (_name, prompt) => {
    expect(prompt.append).toContain('U+2014');
    expect(prompt.append).toMatch(/NEVER use the em dash/);
  });

  test.each(paths)('%s prompt uses none itself, beyond the rule', (_name, prompt) => {
    // The rule quotes both characters, so one of each is expected and no more.
    expect(prompt.append.split(EM_DASH).length - 1).toBe(1);
    expect(prompt.append.split(EN_DASH).length - 1).toBe(1);
  });

  test('the source file holds no literal dash outside the escapes', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/services/BuiltinSystemPrompts.js'),
      'utf8'
    );

    expect(src).not.toContain(EM_DASH);
    expect(src).not.toContain(EN_DASH);
  });
});
