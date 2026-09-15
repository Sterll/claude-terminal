/** @jest-environment node */
const { EventEmitter } = require('node:events');
const { handle, cancel } = require('../../src/main/utils/cancellableOperation');
const sender = id => Object.assign(new EventEmitter(), { id, isDestroyed: () => false, send: jest.fn() });
test('only the owning window cancels an operation and its ID is reusable after completion', async () => {
  let run;
  const ipc = { handle: (_channel, action) => { run = action; } };
  handle(ipc, 'test', async (_event, _params, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
  });
  const owner = { sender: sender(1) }, other = { sender: sender(2) };
  const first = run(owner, { operationId: 'id' });
  cancel(other, 'id');
  expect((await run(owner, { operationId: 'id' })).error).toBe('Operation is already running');
  cancel(owner, 'id');
  expect(await first).toMatchObject({ success: false, cancelled: true });
  expect(owner.sender.listenerCount('destroyed')).toBe(0);
  const retry = run(owner, { operationId: 'id' }); owner.sender.emit('destroyed');
  expect(await retry).toMatchObject({ cancelled: true });
});
