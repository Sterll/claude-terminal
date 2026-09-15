'use strict';
const { spawn, execFile } = require('node:child_process');
// A bounded command with process-tree cancellation. Callers supply an executable
// and argv; renderer input must never select an arbitrary command here.
function runCommand(command, args, { cwd, env = process.env, signal, onProgress, timeoutMs = 300000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 10000 }, () => {});
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    const data = chunk => { output = (output + chunk.toString()).slice(-16384); onProgress?.(chunk.toString()); };
    child.stdout.on('data', data); child.stderr.on('data', data);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (signal?.aborted) { reject(signal.reason); return; }
      if (timedOut) { reject(new Error('Operation exceeded its time limit')); return; }
      if (code !== 0) reject(new Error(output || `${command} exited with code ${code}`)); else resolve(output);
    });
  });
}
module.exports = { runCommand };
