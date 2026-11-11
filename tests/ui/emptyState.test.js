// The shared empty-state block: it explains, it offers, and it does nothing
// until a click. A remote project is told why an action is not offered rather
// than handed a button that fails.

const { createEmptyState, mountEmptyState } = require('../../src/renderer/ui/components/EmptyState');

const REMOTE = { id: 'r1', path: 'ssh-remote://abcd1234/home/dev/app', remote: { profileId: 'abcd1234', path: '/home/dev/app' } };
const LOCAL = { id: 'l1', path: '/home/dev/app' };

beforeEach(() => { document.body.innerHTML = ''; });

test('says what the screen is for and offers one primary action', () => {
  const onClick = jest.fn();
  const block = createEmptyState({
    id: 'demo',
    title: 'Nothing yet',
    purpose: 'This screen keeps your things in one place.',
    action: { id: 'demo-go', label: 'Start', onClick },
  });
  document.body.appendChild(block);

  expect(block.dataset.emptyState).toBe('demo');
  expect(block.querySelector('.empty-guide-title').textContent).toBe('Nothing yet');
  expect(block.querySelector('.empty-guide-purpose').textContent).toBe('This screen keeps your things in one place.');
  expect(block.querySelectorAll('.empty-guide-action')).toHaveLength(1);
  expect(onClick).not.toHaveBeenCalled();

  document.getElementById('demo-go').click();
  expect(onClick).toHaveBeenCalledTimes(1);
});

test('nothing runs on render: examples and links wait for their own click', () => {
  const action = jest.fn();
  const example = jest.fn();
  const link = jest.fn();
  const block = createEmptyState({
    id: 'demo',
    title: 'Nothing yet',
    purpose: 'Why.',
    action: { label: 'Start', onClick: action },
    examples: { label: 'Or try', items: [{ id: 'ex-a', label: 'A', onClick: example }, { id: 'ex-b', label: 'B', onClick: example }] },
    links: [{ id: 'lnk', label: 'Settings', shortcut: 'Ctrl+,', onClick: link }],
  });
  document.body.appendChild(block);

  expect(action).not.toHaveBeenCalled();
  expect(example).not.toHaveBeenCalled();
  expect(link).not.toHaveBeenCalled();
  expect(block.querySelector('.empty-guide-examples-label').textContent).toBe('Or try');
  expect(block.querySelector('#lnk kbd').textContent).toBe('Ctrl+,');

  document.getElementById('ex-b').click();
  expect(example).toHaveBeenCalledTimes(1);
  expect(action).not.toHaveBeenCalled();
  document.getElementById('lnk').click();
  expect(link).toHaveBeenCalledTimes(1);
});

test('text is never parsed as HTML', () => {
  const block = createEmptyState({ id: 'x', title: '<img src=x onerror=alert(1)>', purpose: '<b>bold</b>', action: { label: '<i>go</i>', onClick() {} } });
  expect(block.querySelector('img')).toBeNull();
  expect(block.querySelector('b')).toBeNull();
  expect(block.querySelector('.empty-guide-btn-label').textContent).toBe('<i>go</i>');
});

test('a local project gets the action as usual', () => {
  const onClick = jest.fn();
  const block = createEmptyState({ id: 'x', title: 'T', purpose: 'P', action: { id: 'go', label: 'Go', onClick, requires: { project: LOCAL, feature: 'parallelTasks' } } });
  document.body.appendChild(block);
  const btn = document.getElementById('go');
  expect(btn.classList.contains('is-disabled')).toBe(false);
  expect(block.querySelector('.empty-guide-reason')).toBeNull();
  btn.click();
  expect(onClick).toHaveBeenCalledTimes(1);
});

test('a remote project sees the existing reason instead of an action that would fail', () => {
  const onClick = jest.fn();
  const example = jest.fn();
  const block = createEmptyState({
    id: 'x', title: 'T', purpose: 'P',
    action: { id: 'go', label: 'Go', onClick, requires: { project: REMOTE, feature: 'parallelTasks' } },
    examples: { items: [{ id: 'ex', label: 'Example', onClick: example }] },
  });
  document.body.appendChild(block);

  const btn = document.getElementById('go');
  expect(btn.classList.contains('is-disabled')).toBe(true);
  expect(btn.getAttribute('aria-disabled')).toBe('true');
  // The i18n key resolves to the translated reason; it is shown once, as text.
  const reasons = block.querySelectorAll('.empty-guide-reason');
  expect(reasons).toHaveLength(1);
  expect(reasons[0].textContent).toBe(btn.title);
  expect(reasons[0].textContent).not.toBe('');

  btn.click();
  // Examples lead to the same action, so they inherit its refusal.
  expect(document.getElementById('ex').classList.contains('is-disabled')).toBe(true);
  document.getElementById('ex').click();
  expect(onClick).not.toHaveBeenCalled();
  expect(example).not.toHaveBeenCalled();
});

test('a link refused for a remote project leaves the rest usable', () => {
  const action = jest.fn();
  const detect = jest.fn();
  const block = createEmptyState({
    id: 'x', title: 'T', purpose: 'P',
    action: { id: 'go', label: 'Go', onClick: action },
    links: [{ id: 'detect', label: 'Detect', onClick: detect, requires: { project: REMOTE, feature: 'databaseDetect' } }],
  });
  document.body.appendChild(block);
  document.getElementById('detect').click();
  expect(detect).not.toHaveBeenCalled();
  expect(block.querySelector('.empty-guide-reason')).not.toBeNull();
  document.getElementById('go').click();
  expect(action).toHaveBeenCalledTimes(1);
});

test('mountEmptyState replaces what the container held', () => {
  const container = document.createElement('div');
  container.innerHTML = '<p class="old">old</p>';
  const block = mountEmptyState(container, { id: 'm', title: 'T', purpose: 'P', className: 'legacy-hook' });
  expect(container.querySelector('.old')).toBeNull();
  expect(container.firstElementChild).toBe(block);
  expect(block.classList.contains('legacy-hook')).toBe(true);
  expect(mountEmptyState(null, { id: 'm' })).toBeNull();
});
