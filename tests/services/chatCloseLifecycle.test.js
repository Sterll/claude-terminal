/** @jest-environment node */
const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

it('cancels pending/obsolete sessions and terminates real SDK subprocesses', async () => {
  const result = await promisify(execFile)(process.execPath, [path.resolve(__dirname, '../fixtures/chat-lifecycle.cjs')], { timeout: 40000 });
  expect(result.stdout).toContain('PASS pending SDK/account close');
  expect(result.stdout).toContain('PASS real SDK normal child exited');
  expect(result.stdout).toContain('PASS real SDK stubborn child exited');
}, 45000);
