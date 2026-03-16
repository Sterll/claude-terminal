// Project IPC handler tests

const path = require('path');

// In-memory filesystem for testing
const mockFs = {};
const mockDirs = new Set();

jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn(),
    removeHandler: jest.fn()
  }
}));

const mockFsStat = jest.fn();
const mockFsReaddir = jest.fn();
const mockFsReadFile = jest.fn();

jest.mock('fs', () => ({
  promises: {
    stat: (...args) => mockFsStat(...args),
    readdir: (...args) => mockFsReaddir(...args),
    readFile: (...args) => mockFsReadFile(...args)
  },
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn()
}));

jest.mock('../../src/main/utils/paths', () => ({
  projectsFile: '/mock/data/projects.json'
}));

const { ipcMain } = require('electron');
const { registerProjectHandlers } = require('../../src/main/ipc/project.ipc');

const handlers = {};

beforeAll(() => {
  ipcMain.handle.mockImplementation((channel, handler) => {
    handlers[channel] = handler;
  });
  registerProjectHandlers();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Clear mock filesystem
  for (const key of Object.keys(mockFs)) delete mockFs[key];
  mockDirs.clear();

  // Wire up mock fs implementations
  mockFsStat.mockImplementation(async (p) => {
    if (mockDirs.has(p)) return { isDirectory: () => true, isFile: () => false };
    if (mockFs[p] !== undefined) return { isDirectory: () => false, isFile: () => true };
    const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
  });

  mockFsReaddir.mockImplementation(async (dir) => {
    const entries = [];
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    const seen = new Set();
    for (const key of [...Object.keys(mockFs), ...mockDirs]) {
      if (key.startsWith(prefix)) {
        const relative = key.slice(prefix.length);
        const firstPart = relative.split(path.sep)[0].split('/')[0];
        if (firstPart && !seen.has(firstPart)) {
          seen.add(firstPart);
          entries.push(firstPart);
        }
      }
    }
    return entries;
  });

  mockFsReadFile.mockImplementation(async (filePath) => {
    if (mockFs[filePath] !== undefined) return mockFs[filePath];
    const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
  });
});

// Helper to set up a project directory with files
function setupProject(basePath, files) {
  mockDirs.add(path.resolve(basePath));
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(path.resolve(basePath), filePath);
    mockFs[fullPath] = content;
    // Ensure parent dirs exist in mockDirs
    let dir = path.dirname(fullPath);
    while (dir !== path.resolve(basePath) && dir !== path.dirname(dir)) {
      mockDirs.add(dir);
      dir = path.dirname(dir);
    }
  }
}

// ── scan-todos ──

describe('scan-todos', () => {
  const mockEvent = {};

  test('handler is registered', () => {
    expect(handlers['scan-todos']).toBeDefined();
  });

  test('returns empty array for null projectPath', async () => {
    const result = await handlers['scan-todos'](mockEvent, null);
    expect(result).toEqual([]);
  });

  test('returns empty array for empty string projectPath', async () => {
    const result = await handlers['scan-todos'](mockEvent, '');
    expect(result).toEqual([]);
  });

  test('returns empty array for non-string projectPath', async () => {
    const result = await handlers['scan-todos'](mockEvent, 123);
    expect(result).toEqual([]);
  });

  test('returns empty array for non-existent path', async () => {
    const result = await handlers['scan-todos'](mockEvent, '/nonexistent/path');
    expect(result).toEqual([]);
  });

  test('returns empty array for file path (not directory)', async () => {
    mockFs[path.resolve('/some/file.js')] = 'content';
    const result = await handlers['scan-todos'](mockEvent, '/some/file.js');
    expect(result).toEqual([]);
  });

  test('finds // TODO comments in .js files', async () => {
    setupProject('/project', {
      'app.js': '// TODO: Fix this bug\nconst x = 1;'
    });

    const result = await handlers['scan-todos'](mockEvent, '/project');

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('TODO');
    expect(result[0].text).toBe('Fix this bug');
    expect(result[0].file).toBe('app.js');
    expect(result[0].line).toBe(1);
  });

  test('finds # FIXME comments in .py files', async () => {
    setupProject('/project', {
      'main.py': 'x = 1\n# FIXME: Memory leak here'
    });

    const result = await handlers['scan-todos'](mockEvent, '/project');

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('FIXME');
    expect(result[0].text).toBe('Memory leak here');
    expect(result[0].line).toBe(2);
  });

  test('finds -- HACK comments in .lua files', async () => {
    setupProject('/project', {
      'script.lua': '-- HACK: Temporary workaround'
    });

    const result = await handlers['scan-todos'](mockEvent, '/project');

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('HACK');
    expect(result[0].text).toBe('Temporary workaround');
  });

  test('finds // XXX comments', async () => {
    setupProject('/project', {
      'code.ts': '// XXX: Needs review'
    });

    const result = await handlers['scan-todos'](mockEvent, '/project');

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('XXX');
    expect(result[0].text).toBe('Needs review');
  });

  test('matches case-insensitively', async () => {
    setupProject('/project', {
      'code.js': '// todo: lowercase todo'
    });

    const result = await handlers['scan-todos'](mockEvent, '/project');

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('TODO');
  });

  test('handles TODO without description', async () => {
    setupProject('/project', {
      'code.js': '// TODO: '
    });

    const result = await handlers['scan-todos'](mockEvent, '/project');

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('(no description)');
  });

  test('returns empty array for empty project (no matching files)', async () => {
    setupProject('/project', {
      'readme.md': '# TODO: This is in markdown, not scanned'
    });

    const result = await handlers['scan-todos'](mockEvent, '/project');

    expect(result).toEqual([]);
  });

  test('ignores node_modules directory', async () => {
    setupProject('/project', {
      'app.js': '// TODO: Real todo'
    });
    // Manually add a node_modules file
    const nmPath = path.join(path.resolve('/project'), 'node_modules', 'pkg.js');
    mockFs[nmPath] = '// TODO: Should be ignored';
    mockDirs.add(path.join(path.resolve('/project'), 'node_modules'));

    const result = await handlers['scan-todos'](mockEvent, '/project');

    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('app.js');
  });

  test('finds multiple todos in same file', async () => {
    setupProject('/project', {
      'code.js': '// TODO: First\n// FIXME: Second\nconst x = 1;\n// HACK: Third'
    });

    const result = await handlers['scan-todos'](mockEvent, '/project');

    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('TODO');
    expect(result[1].type).toBe('FIXME');
    expect(result[2].type).toBe('HACK');
    expect(result[0].line).toBe(1);
    expect(result[1].line).toBe(2);
    expect(result[2].line).toBe(4);
  });

  test('caps results at 50 todos', async () => {
    const lines = [];
    for (let i = 0; i < 60; i++) {
      lines.push(`// TODO: Item ${i}`);
    }
    setupProject('/project', {
      'many-todos.js': lines.join('\n')
    });

    const result = await handlers['scan-todos'](mockEvent, '/project');

    expect(result.length).toBeLessThanOrEqual(50);
  });

  test('scans supported file extensions', async () => {
    setupProject('/project', {
      'a.ts': '// TODO: TypeScript',
      'b.jsx': '// TODO: JSX',
      'c.tsx': '// TODO: TSX',
      'd.vue': '// TODO: Vue',
      'e.go': '// TODO: Go',
      'f.rs': '// TODO: Rust',
      'g.java': '// TODO: Java',
      'h.cpp': '// TODO: C++',
      'i.c': '// TODO: C',
      'j.h': '// TODO: Header',
    });

    const result = await handlers['scan-todos'](mockEvent, '/project');

    expect(result.length).toBe(10);
  });
});

// ── project:set-cloud-key ──

describe('project:set-cloud-key', () => {
  const mockEvent = {};
  const fs = require('fs');

  test('handler is registered', () => {
    expect(handlers['project:set-cloud-key']).toBeDefined();
  });

  test('throws for missing projectId', async () => {
    await expect(handlers['project:set-cloud-key'](mockEvent, { cloudProjectKey: 'key' }))
      .rejects.toThrow('Invalid projectId');
  });

  test('throws for non-string projectId', async () => {
    await expect(handlers['project:set-cloud-key'](mockEvent, { projectId: 123 }))
      .rejects.toThrow('Invalid projectId');
  });

  test('throws when project not found', async () => {
    fs.readFileSync.mockReturnValue(JSON.stringify({ projects: [{ id: 'p1', name: 'A' }] }));

    await expect(handlers['project:set-cloud-key'](mockEvent, { projectId: 'p-missing', cloudProjectKey: 'key' }))
      .rejects.toThrow('Project not found');
  });

  test('sets cloudProjectKey on project', async () => {
    const data = { projects: [{ id: 'p1', name: 'Test' }] };
    fs.readFileSync.mockReturnValue(JSON.stringify(data));

    const result = await handlers['project:set-cloud-key'](mockEvent, { projectId: 'p1', cloudProjectKey: 'my-key' });

    expect(result).toEqual({ ok: true });
    expect(fs.writeFileSync).toHaveBeenCalled();
    const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(writtenData.projects[0].cloudProjectKey).toBe('my-key');
  });

  test('removes cloudProjectKey when value is empty', async () => {
    const data = { projects: [{ id: 'p1', name: 'Test', cloudProjectKey: 'old-key' }] };
    fs.readFileSync.mockReturnValue(JSON.stringify(data));

    await handlers['project:set-cloud-key'](mockEvent, { projectId: 'p1', cloudProjectKey: '' });

    const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(writtenData.projects[0].cloudProjectKey).toBeUndefined();
  });

  test('removes cloudProjectKey when value is null', async () => {
    const data = { projects: [{ id: 'p1', name: 'Test', cloudProjectKey: 'old-key' }] };
    fs.readFileSync.mockReturnValue(JSON.stringify(data));

    await handlers['project:set-cloud-key'](mockEvent, { projectId: 'p1', cloudProjectKey: null });

    const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(writtenData.projects[0].cloudProjectKey).toBeUndefined();
  });

  test('trims whitespace from cloudProjectKey', async () => {
    const data = { projects: [{ id: 'p1', name: 'Test' }] };
    fs.readFileSync.mockReturnValue(JSON.stringify(data));

    await handlers['project:set-cloud-key'](mockEvent, { projectId: 'p1', cloudProjectKey: '  my-key  ' });

    const writtenData = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(writtenData.projects[0].cloudProjectKey).toBe('my-key');
  });

  test('uses atomic write (tmp + rename)', async () => {
    const data = { projects: [{ id: 'p1', name: 'Test' }] };
    fs.readFileSync.mockReturnValue(JSON.stringify(data));

    await handlers['project:set-cloud-key'](mockEvent, { projectId: 'p1', cloudProjectKey: 'key' });

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/mock/data/projects.json.tmp',
      expect.any(String),
      'utf8'
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      '/mock/data/projects.json.tmp',
      '/mock/data/projects.json'
    );
  });
});
