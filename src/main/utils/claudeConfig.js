'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withCrossProcessLock } = require('./fileLock');

/** All app-owned writers of ~/.claude.json share this read/modify/write boundary. */
async function updateClaudeConfig(mutate) {
  const file = path.join(require('os').homedir(), '.claude.json');
  return withCrossProcessLock(file + '.lock', async () => {
    let original;
    try { original = await fs.promises.readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const config = original === undefined ? {} : JSON.parse(original);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid Claude configuration');
    await mutate(config);
    if (original !== undefined) {
      if (await fs.promises.readFile(file, 'utf8') !== original) throw new Error('Claude configuration changed during update; retry');
      await fs.promises.writeFile(file + '.backup', original, { mode: 0o600 });
    }
    const temporary = file + '.tmp.' + crypto.randomBytes(8).toString('hex');
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
      await fs.promises.rename(temporary, file);
    } finally { await fs.promises.unlink(temporary).catch(() => {}); }
  });
}

module.exports = { updateClaudeConfig };
