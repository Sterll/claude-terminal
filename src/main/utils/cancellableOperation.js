'use strict';
const { randomUUID } = require('node:crypto');
const pending = new Map();
function cancel(event, id) { pending.get(`${event.sender.id}:${id}`)?.abort(); }
function handle(ipcMain, channel, action) {
  ipcMain.handle(channel, async (event, params = {}) => {
    const id = params.operationId || randomUUID(), key = `${event.sender.id}:${id}`;
    if (pending.has(key)) return { success: false, error: 'Operation is already running' };
    const controller = new AbortController(); pending.set(key, controller);
    const stop = () => controller.abort();
    event.sender.once('destroyed', stop);
    const progress = value => { if (!event.sender.isDestroyed()) event.sender.send('operation-progress', { operationId: id, ...value }); };
    try {
      const result = await action(event, params, controller.signal, progress);
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      return { success: false, cancelled: controller.signal.aborted, error: controller.signal.aborted ? 'Operation cancelled' : error.message };
    } finally { pending.delete(key); event.sender.removeListener('destroyed', stop); }
  });
}
module.exports = { handle, cancel };
