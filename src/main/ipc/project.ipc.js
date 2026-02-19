/**
 * Project IPC Handlers
 * Handles project scanning and statistics
 */

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Register project IPC handlers
 */
function registerProjectHandlers() {
  // Scan TODO/FIXME in project
  ipcMain.handle('scan-todos', async (event, projectPath) => {
    // Validate projectPath to prevent path traversal
    if (!projectPath || typeof projectPath !== 'string') return [];
    const resolvedPath = path.resolve(projectPath);
    try {
      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isDirectory()) return [];
    } catch (e) {
      return [];
    }

    const todos = [];
    const extensions = ['.js', '.ts', '.jsx', '.tsx', '.vue', '.py', '.lua', '.go', '.rs', '.java', '.cpp', '.c', '.h'];
    const ignoreDirs = ['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', 'vendor'];

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
              await scanFile(fullPath, projectPath);
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
          const todoMatch = line.match(/\/\/\s*(TODO|FIXME|HACK|XXX)[:\s]*(.*)/i) ||
                            line.match(/#\s*(TODO|FIXME|HACK|XXX)[:\s]*(.*)/i) ||
                            line.match(/--\s*(TODO|FIXME|HACK|XXX)[:\s]*(.*)/i);
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

module.exports = { registerProjectHandlers };
