/**
 * The chat's side column. What it must get right: one collapsed-or-not choice,
 * and one fold per section, for every chat tab, remembered across launches;
 * and a collapsed strip, or a folded header, that still says when the brief is
 * behind and when a task runs.
 */

'use strict';

function markup() {
  const root = document.createElement('div');
  root.innerHTML = `
    <aside class="chat-side">
      <button class="chat-side-collapse"></button>
      <section class="chat-side-section" data-section="brief">
        <div class="chat-side-section-head" role="button" tabindex="0"><span class="chat-side-section-title"></span></div>
      </section>
      <section class="chat-side-section" data-section="tasks">
        <div class="chat-side-section-head" role="button" tabindex="0">
          <span class="chat-side-section-title"></span><button class="chat-tasks-clear"></button>
        </div>
      </section>
    </aside>
    <button class="chat-side-rail">
      <span class="chat-side-rail-brief"></span>
      <span class="chat-side-rail-tasks" hidden></span>
    </button>`;
  document.body.appendChild(root);
  return { sideEl: root.querySelector('.chat-side'), railEl: root.querySelector('.chat-side-rail') };
}

describe('chat side column', () => {
  let createSidePanel, STORAGE_KEY;

  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = '';
    document.body.className = '';
    localStorage.clear();
    ({ createSidePanel, STORAGE_KEY } = require('../../src/renderer/ui/components/chat/sidePanel'));
  });

  test('starts expanded, and comes back collapsed if it was left so', () => {
    expect(createSidePanel(markup()).isCollapsed()).toBe(false);

    jest.resetModules();
    localStorage.setItem(STORAGE_KEY, 'true');
    ({ createSidePanel } = require('../../src/renderer/ui/components/chat/sidePanel'));
    expect(createSidePanel(markup()).isCollapsed()).toBe(true);
    expect(document.body.classList.contains('chat-side-collapsed')).toBe(true);
  });

  test('collapsing in one tab collapses every tab, and the strip brings all of them back', () => {
    const a = markup();
    const b = markup();
    const onExpandA = jest.fn();
    const onExpandB = jest.fn();
    const panelA = createSidePanel({ ...a, onExpand: onExpandA });
    createSidePanel({ ...b, onExpand: onExpandB });

    a.sideEl.querySelector('.chat-side-collapse').click();
    expect(panelA.isCollapsed()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');

    b.railEl.click();
    expect(panelA.isCollapsed()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
    expect(onExpandA).toHaveBeenCalledTimes(1);
    expect(onExpandB).toHaveBeenCalledTimes(1);
  });

  test('the strip signals a brief behind and a running task', () => {
    const els = markup();
    const panel = createSidePanel(els);
    const brief = els.railEl.querySelector('.chat-side-rail-brief');
    const tasks = els.railEl.querySelector('.chat-side-rail-tasks');

    panel.setBriefBehind(true);
    expect(brief.classList.contains('behind')).toBe(true);
    panel.setBriefBehind(false);
    expect(brief.classList.contains('behind')).toBe(false);

    panel.setTasks({ count: 0, running: 0 });
    expect(tasks.hidden).toBe(true);
    panel.setTasks({ count: 2, running: 1 });
    expect(tasks.hidden).toBe(false);
    expect(tasks.classList.contains('running')).toBe(true);
    panel.setTasks({ count: 2, running: 0 });
    expect(tasks.classList.contains('running')).toBe(false);
  });

  test('each section folds from its header, for every tab, and comes back folded', () => {
    const a = markup();
    const b = markup();
    const onExpand = jest.fn();
    const panel = createSidePanel({ ...a, onExpand });
    createSidePanel(b);
    const headA = a.sideEl.querySelector('[data-section="brief"] .chat-side-section-head');
    const headB = b.sideEl.querySelector('[data-section="brief"] .chat-side-section-head');
    expect(headA.getAttribute('aria-expanded')).toBe('true');

    headA.click();
    expect(panel.isFolded('brief')).toBe(true);
    expect(panel.isFolded('tasks')).toBe(false);
    expect(headB.getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem('chat-side-folded-brief')).toBe('true');
    expect(onExpand).not.toHaveBeenCalled();

    // The keyboard too, and unfolding is a section back on screen.
    headB.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(panel.isFolded('brief')).toBe(false);
    expect(onExpand).toHaveBeenCalledTimes(1);

    headA.click();
    jest.resetModules();
    document.body.className = '';
    ({ createSidePanel } = require('../../src/renderer/ui/components/chat/sidePanel'));
    const restored = createSidePanel(markup());
    expect(restored.isFolded('brief')).toBe(true);
  });

  test('a button in a header does its own thing, it does not fold the section', () => {
    const els = markup();
    const panel = createSidePanel(els);
    els.sideEl.querySelector('.chat-tasks-clear').click();
    expect(panel.isFolded('tasks')).toBe(false);
  });

  test('a folded header keeps its signal', () => {
    const els = markup();
    const panel = createSidePanel(els);
    panel.setBriefBehind(true);
    panel.setTasks({ count: 1, running: 1 });
    expect(els.sideEl.querySelector('[data-section="brief"] .chat-side-section-head').classList.contains('behind')).toBe(true);
    expect(els.sideEl.querySelector('[data-section="tasks"] .chat-side-section-head').classList.contains('running')).toBe(true);
  });

  test('a destroyed tab no longer follows', () => {
    const els = markup();
    const onExpand = jest.fn();
    const panel = createSidePanel({ ...els, onExpand });
    panel.destroy();
    window.dispatchEvent(new CustomEvent('chat-side-toggled', { detail: { collapsed: false } }));
    expect(onExpand).not.toHaveBeenCalled();
  });
});
