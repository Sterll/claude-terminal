'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');

// Only extract into an empty staging directory owned by the caller.
module.exports = async function extractZip(file, { dir, maxBytes = 1024 ** 3, maxEntries = 10000 }) {
  const root = path.resolve(dir);
  await fs.promises.mkdir(root, { recursive: true });
  if ((await fs.promises.readdir(root)).length) throw new Error('Extraction requires an empty directory');
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  let bytes = 0, entries = 0;
  return new Promise((resolve, reject) => {
    const fail = error => { zip.close(); reject(error); };
    zip.on('error', fail);
    zip.on('end', resolve);
    zip.on('entry', entry => {
      (async () => {
        const name = entry.fileName.replace(/\\/g, '/');
        const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (++entries > maxEntries || (bytes += entry.uncompressedSize) > maxBytes) throw new Error('Archive exceeds extraction limits');
        if (kind && kind !== 0x8000 && kind !== 0x4000) throw new Error('Archive links and special files are not supported');
        if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..') || name.includes('\0')) throw new Error('Invalid archive path');
        const destination = path.resolve(root, name);
        if (!destination.startsWith(root + path.sep)) throw new Error('Invalid archive path');
        if (name.endsWith('/')) await fs.promises.mkdir(destination, { recursive: true });
        else {
          await fs.promises.mkdir(path.dirname(destination), { recursive: true });
          const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
          // Exclusive creation also rejects duplicate entries and pre-existing links.
          await pipeline(stream, fs.createWriteStream(destination, { flags: 'wx', mode: (entry.externalFileAttributes >>> 16) & 0o111 ? 0o700 : 0o600 }));
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
};
