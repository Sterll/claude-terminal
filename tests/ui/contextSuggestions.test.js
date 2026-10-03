/**
 * The rotating placeholder of the chat composer.
 *
 * Every turn sets "Queue a follow-up message" and relies on the next refresh
 * to replace it. With no hint to show (a clean work tree), that refresh used
 * to return early and the follow-up placeholder stayed on an idle composer.
 */

const { createContextSuggestions } = require('../../src/renderer/ui/components/chat/contextSuggestions');

function makeApi(gitStatus) {
  return {
    project: { scanTodos: jest.fn(async () => []) },
    git: { statusDetailed: jest.fn(async () => gitStatus) },
  };
}

test('with no hint to show, a refresh puts the default placeholder back', async () => {
  const api = makeApi({ modified: [], staged: [], untracked: [] });
  const input = { setPlaceholder: jest.fn(), isEmpty: () => true };
  const hint = createContextSuggestions(api, { path: 'C:\\code\\app' }, input, () => 'Ask');

  await hint.refresh();

  expect(input.setPlaceholder).toHaveBeenLastCalledWith('Ask');
  hint.stop();
});

test('it never writes over something the user typed', async () => {
  const api = makeApi({ modified: [], staged: [], untracked: [] });
  const input = { setPlaceholder: jest.fn(), isEmpty: () => false };
  const hint = createContextSuggestions(api, { path: 'C:\\code\\app' }, input, () => 'Ask');

  await hint.refresh();

  expect(input.setPlaceholder).not.toHaveBeenCalled();
  hint.stop();
});
