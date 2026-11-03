/**
 * The subagent effort select of a workflow Claude step (claude-config field).
 *
 * '' is "inherit the chat settings", the default, and the only other values
 * are the five levels the CLI takes. The generic node-prop binding saves it,
 * so the select only has to carry the right data-key and values.
 */

const field = require('../../src/renderer/workflow-fields/claude-config.field');
const { SUBAGENT_EFFORT_LEVELS } = require('../../src/shared/model-options');

function selectFor(properties) {
  document.body.innerHTML = field.render({}, '', { properties });
  return document.querySelector('select[data-key="subagentEffort"]');
}

test('a step that never chose one inherits the chat settings', () => {
  const select = selectFor({ mode: 'prompt', effort: 'medium' });
  expect(select).not.toBeNull();
  expect(select.classList.contains('wf-node-prop')).toBe(true);
  expect(select.value).toBe('');
  expect([...select.options].map(o => o.value)).toEqual(['', ...SUBAGENT_EFFORT_LEVELS]);
});

test('a chosen level is shown as chosen', () => {
  expect(selectFor({ mode: 'prompt', subagentEffort: 'xhigh' }).value).toBe('xhigh');
});

test('the step effort select is still there, unchanged', () => {
  selectFor({ mode: 'prompt', effort: 'high' });
  expect(document.querySelector('select[data-key="effort"]').value).toBe('high');
});
