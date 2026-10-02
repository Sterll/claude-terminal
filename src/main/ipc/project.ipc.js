/**
 * Project IPC Handlers
 * Handles project scanning and statistics
 */

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const operations = require('../utils/cancellableOperation');
const { projectsFile } = require('../utils/paths');
const remotePath = require('../../shared/remote-path');

// Pre-compiled regex patterns for TODO scanning (avoid re-allocation per line).
//
// `(?=[:\s(]|$)` after the keyword is what keeps markup and CSS out of the
// list: the keyword has to be followed by a real separator, so `#todo-list { }`
// and `href="#todo"` no longer read as HASH comments introducing a TODO whose
// text is the rest of the line. `(` stays allowed for the `TODO(owner):` form.
//
// Order matters below. HTML is tried before LUA because `<!--` contains `--`,
// so the LUA pattern matches an HTML comment first and keeps the trailing
// `-->` in the text — which is how the HTML pattern ended up unreachable.
const TODO_REGEX_HTML  = /<!--\s*(TODO|FIXME|HACK|XXX)(?=[:\s(]|$)[:\s]*(.*?)(?:-->|$)/i;
const TODO_REGEX_BLOCK = /\/\*\s*(TODO|FIXME|HACK|XXX)(?=[:\s(]|$)[:\s]*(.*?)(?:\*\/|$)/i;
const TODO_REGEX_SLASH = /\/\/\s*(TODO|FIXME|HACK|XXX)(?=[:\s(]|$)[:\s]*(.*)/i;
const TODO_REGEX_HASH  = /#\s*(TODO|FIXME|HACK|XXX)(?=[:\s(]|$)[:\s]*(.*)/i;
const TODO_REGEX_LUA   = /--\s*(TODO|FIXME|HACK|XXX)(?=[:\s(]|$)[:\s]*(.*)/i;

const TODO_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.vue', '.py', '.lua', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.html', '.css'];
const TODO_IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', 'vendor'];
const TODO_MAX = 50;

/** The TODO a single line carries, or null. The same patterns, in the same order, as the local scan. */
function classifyTodoLine(line) {
  const todoMatch = TODO_REGEX_HTML.exec(line) ||
                    TODO_REGEX_BLOCK.exec(line) ||
                    TODO_REGEX_SLASH.exec(line) ||
                    TODO_REGEX_HASH.exec(line) ||
                    TODO_REGEX_LUA.exec(line);
  if (!todoMatch) return null;
  return { type: todoMatch[1].toUpperCase(), text: todoMatch[2].trim() || '(no description)' };
}

/**
 * TODO scan of a remote project: one `git grep` (or `grep -rnI` outside a
 * repository) on the host for candidate lines, classified here with the local
 * regexes and capped like the local scan. A host that cannot answer yields an
 * empty list, as an unreadable local folder does.
 * @param {string} uri - ssh-remote:// project path, already validated
 * @param {object} [deps] - injectable for tests
 * @returns {Promise<Array<{type: string, text: string, file: string, line: number}>>}
 */
async function scanTodosRemote(uri, deps = {}) {
  const grep = deps.grepTodoCandidates || require('../utils/git').grepTodoCandidates;
  const result = await grep(uri, { extensions: TODO_EXTENSIONS, ignoreDirs: TODO_IGNORE_DIRS, maxDepth: 5 });
  if (!result || !result.ok) return [];
  const todos = [];
  for (const candidate of result.lines) {
    if (todos.length >= TODO_MAX) break;
    if (!TODO_EXTENSIONS.some(ext => candidate.file.endsWith(ext))) continue;
    const todo = classifyTodoLine(candidate.text);
    if (todo) todos.push({ ...todo, file: candidate.file, line: candidate.line });
  }
  return todos;
}

/** Resolve a remote project path, or throw: configured profile, inside a registered project. */
function requireRemoteProject(uri) {
  return require('../utils/projectTarget').resolveTarget(uri);
}

/**
 * Register project IPC handlers
 */
function registerProjectHandlers() {
  ipcMain.handle('project-init-git', async (_event, { projectPath }) => {
    if (remotePath.isRemotePath(projectPath)) {
      // Remote: a registered remote project, initialised on its host by git.js.
      await requireRemoteProject(projectPath);
    } else if (!require('../utils/rendererSecurity').permitted(projectPath, true)) throw new Error('Project destination is not authorized');
    const result = await require('../utils/git').execGitResult(projectPath, ['init']);
    if (!result.ok) throw new Error(result.error);
    return { success: true };
  });
  operations.handle(ipcMain, 'project-scaffold', async (_event, { template, targetPath }, signal, progress) => {
    // Templates run local generators into a local folder.
    if (remotePath.isRemotePath(targetPath)) throw new Error('Project templates cannot be scaffolded on a remote host');
    if (!require('../utils/rendererSecurity').permitted(targetPath, true)) throw new Error('Project destination is not authorized');
    return require('../utils/projectCreation').scaffold(template, targetPath, { signal, onProgress: message => progress({ message }) });
  });
  // Scan TODO/FIXME in project
  ipcMain.handle('scan-todos', async (event, projectPath) => {
    // Validate projectPath to prevent path traversal
    if (!projectPath || typeof projectPath !== 'string') return [];
    if (remotePath.isRemotePath(projectPath)) {
      try {
        await requireRemoteProject(projectPath);
      } catch (e) {
        return [];
      }
      return scanTodosRemote(projectPath);
    }
    const resolvedPath = path.resolve(projectPath);
    try {
      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isDirectory()) return [];
    } catch (e) {
      return [];
    }

    const todos = [];
    const extensions = TODO_EXTENSIONS;
    const ignoreDirs = TODO_IGNORE_DIRS;

    async function scanDir(dir, depth = 0) {
      if (depth > 5 || todos.length >= 50) return;
      try {
        const items = await fs.promises.readdir(dir);
        for (const item of items) {
          if (todos.length >= 50) return;
          if (ignoreDirs.includes(item)) continue;
          const fullPath = path.join(dir, item);
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.isDirectory()) {
              await scanDir(fullPath, depth + 1);
            } else if (stat.isFile() && extensions.some(ext => item.endsWith(ext))) {
              await scanFile(fullPath, resolvedPath);
            }
          } catch (e) {}
        }
      } catch (e) {}
    }

    async function scanFile(filePath, basePath) {
      try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const lines = content.split('\n');
        const relativePath = path.relative(basePath, filePath);

        lines.forEach((line, i) => {
          const todoMatch = TODO_REGEX_HTML.exec(line) ||
                            TODO_REGEX_BLOCK.exec(line) ||
                            TODO_REGEX_SLASH.exec(line) ||
                            TODO_REGEX_HASH.exec(line) ||
                            TODO_REGEX_LUA.exec(line);
          if (todoMatch && todos.length < 50) {
            todos.push({
              type: todoMatch[1].toUpperCase(),
              text: todoMatch[2].trim() || '(no description)',
              file: relativePath,
              line: i + 1
            });
          }
        });
      } catch (e) {}
    }

    await scanDir(resolvedPath);
    return todos;
  });
}

module.exports = { registerProjectHandlers, scanTodosRemote, classifyTodoLine };
