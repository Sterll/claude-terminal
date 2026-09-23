/**
 * The far side of the pruner's `above` store, held as markup rather than nodes.
 *
 * `TranscriptPruner` detaches entries to bound the cost of interacting with a
 * long transcript, and its header used to say memory was unchanged by design.
 * Measured in this document, that design costs 34 118 bytes of renderer RSS per
 * detached entry against 1 017 for the same entry held as its own `outerHTML` —
 * 33x, and on a window left open for days it is the difference between a
 * renderer at 3 GB and one that is not.
 *
 * Rebuilding an entry from markup drops any listener bound to that element, so
 * the rule is an allowlist: nothing is flattened unless the caller vouches for
 * it. These tests pin both halves — that vouched-for entries are flattened and
 * come back whole, and that everything else is left alone.
 */

const { createTranscriptPruner } = require('../../src/renderer/ui/components/TranscriptPruner');

/** A pane with no layout, which is the count-based path: pinned, no geometry. */
function makePane() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function addEntry(pane, i, { serializable = true } = {}) {
  const el = document.createElement('div');
  el.className = 'chat-msg chat-msg-assistant';
  el.dataset.msgId = `m${i}`;
  if (serializable) el.dataset.serializable = '1';
  el.innerHTML = `<div class="chat-msg-content"><p>turn ${i}</p></div>`;
  pane.appendChild(el);
  return el;
}

const canSerialize = (el) => el.dataset?.serializable === '1';

describe('flattening the far side of the pruned store', () => {
  let pane;

  beforeEach(() => {
    pane = makePane();
  });

  afterEach(() => {
    pane.remove();
  });

  function prunerOver(pane, opts = {}) {
    return createTranscriptPruner({
      messagesEl: pane,
      isPinnedToBottom: () => true,
      translate: (_k, vars) => `older ${vars?.count ?? ''}`,
      canSerialize,
      ...opts,
    });
  }

  test('nothing is flattened by default, so an unaware caller is unaffected', () => {
    for (let i = 0; i < 400; i++) addEntry(pane, i);
    // No canSerialize: the parameter's default refuses everything.
    const pruner = createTranscriptPruner({
      messagesEl: pane,
      isPinnedToBottom: () => true,
      translate: () => 'older',
      serializeAfter: 10,
    });
    pruner.prune();

    expect(pruner.prunedCount).toBeGreaterThan(10);
    expect(pruner.flattenedCount).toBe(0);
  });

  test('entries past the threshold are flattened, the near ones are not', () => {
    for (let i = 0; i < 400; i++) addEntry(pane, i);
    const pruner = prunerOver(pane, { serializeAfter: 20 });
    pruner.prune();

    expect(pruner.prunedCount).toBe(150);
    expect(pruner.flattenedCount).toBe(130);
  });

  test('an entry the caller did not vouch for stays a node', () => {
    for (let i = 0; i < 400; i++) addEntry(pane, i, { serializable: i % 2 === 0 });
    const pruner = prunerOver(pane, { serializeAfter: 20 });
    pruner.prune();

    // Half of everything past the threshold, and not one more.
    expect(pruner.flattenedCount).toBe(65);
  });

  test('a flattened entry comes back with its markup and dataset intact', () => {
    for (let i = 0; i < 400; i++) addEntry(pane, i);
    const pruner = prunerOver(pane, { serializeAfter: 0, chunk: 500 });
    pruner.prune();
    expect(pruner.flattenedCount).toBe(pruner.prunedCount);

    pruner.mountAll();

    const ids = Array.from(pane.querySelectorAll('.chat-msg')).map(el => el.dataset.msgId);
    expect(ids).toEqual(Array.from({ length: 400 }, (_, i) => `m${i}`));
    const first = pane.querySelector('[data-msg-id="m0"]');
    expect(first.dataset.serializable).toBe('1');
    expect(first.querySelector('.chat-msg-content p').textContent).toBe('turn 0');
  });

  test('document order survives a flatten-then-remount round trip', () => {
    for (let i = 0; i < 400; i++) addEntry(pane, i);
    const pruner = prunerOver(pane, { serializeAfter: 5, chunk: 40 });
    pruner.prune();
    pruner.remountChunk(40);
    pruner.remountChunk(40);

    const ids = Array.from(pane.querySelectorAll('.chat-msg')).map(el => Number(el.dataset.msgId.slice(1)));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test('a listener on a flattened entry is gone, which is why the allowlist exists', () => {
    for (let i = 0; i < 400; i++) addEntry(pane, i);
    const victim = pane.querySelector('[data-msg-id="m0"]');
    const onClick = jest.fn();
    victim.addEventListener('click', onClick);

    const pruner = prunerOver(pane, { serializeAfter: 0, chunk: 500 });
    pruner.prune();
    pruner.mountAll();

    pane.querySelector('[data-msg-id="m0"]').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(onClick).not.toHaveBeenCalled();
  });

  // `outerHTML` serialises attributes, so live state a browser keeps only as a
  // DOM property is dropped while state written as an inline style survives —
  // and one feature can land on both sides of that line. The markdown table
  // filter does: its box holds text in `input.value`, its hidden rows use
  // `style.display`, so a rebuilt table came back with an empty box over rows
  // that were still filtered, and stayed that way until the reader retyped.
  test('a live input value is carried into the markup', () => {
    for (let i = 0; i < 400; i++) addEntry(pane, i);
    const host = pane.querySelector('[data-msg-id="m0"]');
    const input = document.createElement('input');
    input.className = 'chat-table-search';
    host.appendChild(input);
    input.value = 'needle';

    const pruner = prunerOver(pane, { serializeAfter: 0, chunk: 500 });
    pruner.prune();
    pruner.mountAll();

    expect(pane.querySelector('.chat-table-search').value).toBe('needle');
  });

  test('a checked box comes back checked', () => {
    for (let i = 0; i < 400; i++) addEntry(pane, i);
    const host = pane.querySelector('[data-msg-id="m0"]');
    const box = document.createElement('input');
    box.type = 'checkbox';
    host.appendChild(box);
    box.checked = true;

    const pruner = prunerOver(pane, { serializeAfter: 0, chunk: 500 });
    pruner.prune();
    pruner.mountAll();

    expect(pane.querySelector('input[type="checkbox"]').checked).toBe(true);
  });

  test('the filter box and the rows it hid come back agreeing', () => {
    for (let i = 0; i < 400; i++) addEntry(pane, i);
    const host = pane.querySelector('[data-msg-id="m0"]');
    host.innerHTML = '<input class="chat-table-search"><table><tr class="hit"><td>a</td></tr>'
      + '<tr class="miss"><td>b</td></tr></table>';
    host.querySelector('.chat-table-search').value = 'a';
    host.querySelector('.miss').style.display = 'none';

    const pruner = prunerOver(pane, { serializeAfter: 0, chunk: 500 });
    pruner.prune();
    pruner.mountAll();

    const back = pane.querySelector('[data-msg-id="m0"]');
    expect(back.querySelector('.chat-table-search').value).toBe('a');
    expect(back.querySelector('.miss').style.display).toBe('none');
  });

  test('a delegated listener still fires on a rebuilt entry', () => {
    for (let i = 0; i < 400; i++) addEntry(pane, i);
    const onClick = jest.fn();
    pane.addEventListener('click', onClick);

    const pruner = prunerOver(pane, { serializeAfter: 0, chunk: 500 });
    pruner.prune();
    pruner.mountAll();

    pane.querySelector('[data-msg-id="m0"]').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('the newer store is never flattened: the stream still writes into it', () => {
    for (let i = 0; i < 400; i++) addEntry(pane, i);
    const pruner = prunerOver(pane, { serializeAfter: 0 });
    pruner.prune();
    // Whatever lands after the bottom marker is absorbed into `below` as nodes.
    expect(pruner.prunedBelowCount).toBe(0);
    expect(typeof pruner.flattenedCount).toBe('number');
  });
});

/**
 * The two buttons that used to bind their own listener.
 *
 * Rewind sits on a user message and fork on an assistant one — that is, on the
 * prose turns, which are exactly the population worth holding as markup. While
 * they bound per element, marking those entries serializable would have
 * silently killed both buttons on anything scrolled far enough back. They are
 * delegated from the transcript root now, reading what they need off the
 * dataset, which is what survives `outerHTML`.
 *
 * Asserted against the real markup rather than through ChatView, because the
 * property under test is that the handler needs nothing but the element.
 */
describe('rewind and fork survive being rebuilt from markup', () => {
  let pane, forkFromMessage, handleRewindFiles;

  beforeEach(() => {
    pane = makePane();
    forkFromMessage = jest.fn();
    handleRewindFiles = jest.fn();
    // The delegation as ChatView installs it.
    pane.addEventListener('click', (e) => {
      const rewindBtn = e.target.closest('.chat-msg-rewind-btn');
      if (rewindBtn) {
        const uuid = rewindBtn.closest('[data-user-message-uuid]')?.dataset.userMessageUuid;
        if (uuid) handleRewindFiles(uuid, rewindBtn);
        return;
      }
      const forkBtn = e.target.closest('.chat-msg-fork-btn');
      if (forkBtn) {
        const host = forkBtn.closest('[data-message-uuid]');
        const uuid = host?.dataset.messageUuid;
        if (uuid) forkFromMessage(uuid, host.dataset.forkDropsTurn || undefined);
      }
    });
  });

  afterEach(() => pane.remove());

  function userTurn(uuid) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-user';
    el.dataset.serializable = '1';
    el.dataset.userMessageUuid = uuid;
    el.innerHTML = '<div class="chat-msg-content">ask</div><button class="chat-msg-rewind-btn">r</button>';
    pane.appendChild(el);
    return el;
  }

  function assistantTurn(uuid, dropsTurn) {
    const el = document.createElement('div');
    el.className = 'chat-msg chat-msg-assistant';
    el.dataset.serializable = '1';
    el.dataset.messageUuid = uuid;
    if (dropsTurn) el.dataset.forkDropsTurn = dropsTurn;
    el.innerHTML = '<div class="chat-msg-content">reply</div><button class="chat-msg-fork-btn">f</button>';
    pane.appendChild(el);
    return el;
  }

  /** Round-trip an entry through the pruner's flattened store. */
  function roundTrip() {
    const pruner = createTranscriptPruner({
      messagesEl: pane,
      isPinnedToBottom: () => true,
      translate: () => 'older',
      canSerialize,
      serializeAfter: 0,
      cap: 1,
      floor: 0,
      chunk: 500,
    });
    pruner.prune();
    expect(pruner.flattenedCount).toBeGreaterThan(0);
    pruner.mountAll();
    return pruner;
  }

  test('rewind still reaches its uuid after a round trip', () => {
    userTurn('u-1');
    for (let i = 0; i < 5; i++) addEntry(pane, i);
    roundTrip();

    pane.querySelector('.chat-msg-rewind-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(handleRewindFiles).toHaveBeenCalledWith('u-1', expect.any(Object));
  });

  test('fork still reaches its uuid and the turn it discards', () => {
    assistantTurn('a-1', 'u-2');
    for (let i = 0; i < 5; i++) addEntry(pane, i);
    roundTrip();

    pane.querySelector('.chat-msg-fork-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(forkFromMessage).toHaveBeenCalledWith('a-1', 'u-2');
  });

  test('a fork off the tail passes undefined, not an empty string', () => {
    assistantTurn('a-2');
    for (let i = 0; i < 5; i++) addEntry(pane, i);
    roundTrip();

    pane.querySelector('.chat-msg-fork-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(forkFromMessage).toHaveBeenCalledWith('a-2', undefined);
  });
});
