// Toast: one implementation, one container, one DOM shape.
//
// Two implementations used to render into two containers while sharing the same
// CSS classes, so what a notification looked like depended on which module raised
// it. These tests pin the parts callers actually reach for — `.toast-content`,
// `.toast-message`, `.toast-close` — plus the coalescing that keeps a repeated
// action from stacking identical cards.

const Toast = require('../../src/renderer/ui/components/Toast');

function container() {
  return document.getElementById('toast-container');
}

function liveToasts() {
  return Array.from(container()?.querySelectorAll('.toast') || []);
}

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = '<div class="toast-container" id="toast-container"></div>';
  Toast.clearAllToasts();
  jest.runOnlyPendingTimers();
  container().innerHTML = '';
});

afterEach(() => {
  jest.useRealTimers();
});

describe('container', () => {
  it('uses the one #toast-container from index.html', () => {
    Toast.showInfo('hello');
    expect(document.querySelectorAll('.toast-container')).toHaveLength(1);
    expect(container().querySelector('.toast')).not.toBeNull();
  });

  it('creates a container when the page ships none', () => {
    document.body.innerHTML = '';
    Toast.showInfo('hello');
    expect(document.querySelectorAll('.toast-container')).toHaveLength(1);
  });
});

describe('shape', () => {
  it('renders icon, content, close for a message-only toast', () => {
    const toast = Toast.showSuccess('Saved');
    expect(toast.querySelector('.toast-icon')).not.toBeNull();
    expect(toast.querySelector('.toast-content')).not.toBeNull();
    expect(toast.querySelector('.toast-message').textContent).toBe('Saved');
    expect(toast.querySelector('.toast-close')).not.toBeNull();
    // No title element when no title was given — an empty node would still take
    // its line-height and push the message off-centre.
    expect(toast.querySelector('.toast-title')).toBeNull();
  });

  it('renders title and message together', () => {
    const toast = Toast.showToast({ type: 'error', title: 'Push failed', message: 'rejected' });
    expect(toast.querySelector('.toast-title').textContent).toBe('Push failed');
    expect(toast.querySelector('.toast-message').textContent).toBe('rejected');
  });

  it('puts the close button last, so nothing renders to its right', () => {
    const toast = Toast.showToast({ message: 'x', action: 'Undo', onAction: () => {} });
    const children = Array.from(toast.children).filter(el => !el.classList.contains('toast-progress'));
    expect(children[children.length - 1].classList.contains('toast-close')).toBe(true);
  });

  it('escapes markup and keeps newlines as breaks', () => {
    const toast = Toast.showInfo('a\n<img src=x onerror=alert(1)>');
    expect(toast.querySelector('img')).toBeNull();
    expect(toast.querySelector('.toast-message').innerHTML).toContain('<br>');
  });

  it('truncates a message too long to read at a glance', () => {
    const toast = Toast.showInfo('x'.repeat(500));
    expect(toast.querySelector('.toast-message').textContent.length).toBeLessThanOrEqual(201);
  });

  it('carries a progress bar only when it auto-hides', () => {
    expect(Toast.showToast({ message: 'a', duration: 3000 }).querySelector('.toast-progress')).not.toBeNull();
    expect(Toast.showToast({ message: 'b', duration: 0 }).querySelector('.toast-progress')).toBeNull();
  });
});

describe('coalescing', () => {
  it('folds an identical repeat into one card with a counter', () => {
    Toast.showSuccess('Settings saved');
    Toast.showSuccess('Settings saved');
    Toast.showSuccess('Settings saved');

    expect(liveToasts()).toHaveLength(1);
    expect(liveToasts()[0].querySelector('.toast-count').textContent).toBe('×3');
  });

  it('keeps different toasts apart', () => {
    Toast.showSuccess('Settings saved');
    Toast.showError('Settings saved');
    Toast.showSuccess('Something else');
    expect(liveToasts()).toHaveLength(3);
  });

  it('never folds a persistent toast — its caller holds and mutates it', () => {
    const first = Toast.showToast({ message: 'Uploading…', duration: 0 });
    const second = Toast.showToast({ message: 'Uploading…', duration: 0 });
    expect(second).not.toBe(first);
    expect(liveToasts()).toHaveLength(2);
  });
});

describe('lifecycle', () => {
  it('auto-hides after its duration', () => {
    Toast.showToast({ message: 'bye', duration: 1000 });
    expect(liveToasts()).toHaveLength(1);
    jest.advanceTimersByTime(1400);
    expect(liveToasts()).toHaveLength(0);
  });

  it('keeps a duration:0 toast until it is dismissed', () => {
    const toast = Toast.showToast({ message: 'stay', duration: 0 });
    jest.advanceTimersByTime(60000);
    expect(liveToasts()).toHaveLength(1);
    toast.querySelector('.toast-close').click();
    jest.advanceTimersByTime(400);
    expect(liveToasts()).toHaveLength(0);
  });

  it('caps the stack at five, dropping the oldest', () => {
    for (let i = 0; i < 8; i++) Toast.showToast({ message: `m${i}`, duration: 5000 });
    const visible = liveToasts().filter(el => !el.classList.contains('hide'));
    expect(visible).toHaveLength(5);
    expect(visible[0].textContent).toContain('m3');
  });

  it('runs the action handler then dismisses', () => {
    const onAction = jest.fn();
    const toast = Toast.showToast({ message: 'deleted', action: 'Undo', onAction });
    toast.querySelector('.toast-action').click();
    expect(onAction).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(400);
    expect(liveToasts()).toHaveLength(0);
  });

  it('is idempotent when hidden twice', () => {
    const toast = Toast.showInfo('x');
    Toast.hideToast(toast);
    Toast.hideToast(toast);
    jest.advanceTimersByTime(400);
    expect(liveToasts()).toHaveLength(0);
  });
});
