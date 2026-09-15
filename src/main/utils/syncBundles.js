'use strict';
const fs = require('fs/promises');
const path = require('path');

function validatePart(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\x00-\x1f:]/.test(name)) throw new Error('Invalid sync path');
}
async function safePath(root, relative) {
  const parts = relative.split('/'); parts.forEach(validatePart);
  let target = root;
  for (const part of ['', ...parts]) {
    target = path.join(target, part);
    try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Sync refuses symbolic links'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
const identity = entry => `${entry.format || 'directory'}:${entry.name}`;
function bundleMeta(data) {
  return { bundleEntries: data.map(entry => ({ name: entry.name, format: entry.format || 'directory', files: [...new Set([...Object.keys(entry.files || {}), ...(entry.deletedFiles || [])])].sort() })) };
}

function bundleHandler({ root, kind, previous, atomicWrite }) {
  const mainFile = kind === 'skills' ? 'SKILL.md' : 'AGENT.md';
  const read = async () => {
    let directory;
    try { directory = await fs.readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; directory = []; }
    const entries = []; let total = 0, count = 0;
    const old = previous();
    async function readFiles(base, relative = '') {
      const files = {};
      for (const item of (await fs.readdir(base, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = relative + item.name;
        if (item.isSymbolicLink()) throw new Error('Sync refuses symbolic links');
        if (item.isDirectory()) Object.assign(files, await readFiles(path.join(base, item.name), name + '/'));
        else if (item.isFile()) {
          const file = path.join(base, item.name), stat = await fs.stat(file);
          total += stat.size;
          if (++count > 10000 || total > 5 * 1024 * 1024) throw new Error('Sync bundle exceeds 5 MiB or 10000 files');
          files[name] = { content: (await fs.readFile(file)).toString('base64'), executable: !!(stat.mode & 0o111) };
        }
      }
      return files;
    }
    for (const item of directory.sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.')) continue;
      if (item.isSymbolicLink()) throw new Error('Sync refuses symbolic links');
      const format = item.isFile() && kind === 'agents' && item.name.endsWith('.md') ? 'file' : 'directory';
      if (format === 'directory' && !item.isDirectory()) continue;
      const target = await safePath(root, item.name);
      let content;
      if (format === 'file') {
        total += (await fs.stat(target)).size;
        if (++count > 10000 || total > 5 * 1024 * 1024) throw new Error('Sync bundle exceeds limits');
      }
      try { content = await fs.readFile(format === 'file' ? target : path.join(target, mainFile), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const files = format === 'file' ? {} : await readFiles(target);
      const entry = { name: item.name, format, content, files };
      const known = old.find(previous => identity(previous) === identity(entry));
      entry.deletedFiles = (known?.files || []).filter(name => !(name in files)).sort();
      entries.push(entry);
    }
    for (const entry of old) if (!entries.some(item => identity(item) === identity(entry))) entries.push({ name: entry.name, format: entry.format, deleted: true });
    return entries.sort((a, b) => identity(a).localeCompare(identity(b)));
  };
  const write = async data => {
    if (!Array.isArray(data)) throw new Error('Invalid sync bundle');
    // Validate the entire payload before the first mutation.
    let bytes = 0, count = 0;
    for (const entry of data) {
      validatePart(entry.name);
      if (entry.format && !['file', 'directory'].includes(entry.format)) throw new Error('Invalid bundle format');
      if (entry.format === 'file' && (kind !== 'agents' || !entry.name.endsWith('.md'))) throw new Error('Invalid agent file');
      await safePath(root, entry.name);
      for (const name of [...Object.keys(entry.files || {}), ...(entry.deletedFiles || [])]) await safePath(root, entry.name + '/' + name);
      bytes += Buffer.byteLength(entry.content || '');
      for (const value of Object.values(entry.files || {})) {
        if (!value || typeof value.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.content)) throw new Error('Invalid bundle content');
        bytes += Buffer.byteLength(value.content); count++;
      }
      if (bytes > 8 * 1024 * 1024 || count > 10000) throw new Error('Sync bundle exceeds limits');
    }
    await fs.mkdir(root, { recursive: true });
    for (const entry of data) {
      const target = await safePath(root, entry.name);
      if (entry.deleted) { await fs.rm(target, { recursive: true, force: true }); continue; }
      if (entry.format === 'file') { await atomicWrite(target, entry.content); continue; }
      await fs.mkdir(target, { recursive: true });
      if (!entry.files?.[mainFile]) await atomicWrite(await safePath(root, entry.name + '/' + mainFile), entry.content || '');
      for (const [name, value] of Object.entries(entry.files || {})) {
        const file = await safePath(root, entry.name + '/' + name);
        await atomicWrite(file, Buffer.from(value.content, 'base64'));
        await fs.chmod(file, value.executable ? 0o700 : 0o600);
      }
      for (const name of entry.deletedFiles || []) {
        if (entry.files?.[name]) continue;
        await fs.rm(await safePath(root, entry.name + '/' + name), { force: true });
      }
    }
  };
  return { settingKey: 'cloudSyncSkills', path: root, isDir: true, read, write, sanitize: data => data, syncMeta: bundleMeta };
}
module.exports = { bundleHandler };
