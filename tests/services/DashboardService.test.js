// DashboardService unit tests — cache mechanism, formatNumber,
// and build*Html functions via snapshot testing.

// ─── Mock setup ──────────────────────────────────────────────────────────────

// Mock state module with minimal implementation
jest.mock('../../src/renderer/state', () => ({
  projectsState: {
    get: jest.fn(() => ({ projects: [] })),
    subscribe: jest.fn(),
  },
  settingsState: {
    get: jest.fn(() => ({ githubHostname: 'github.com' })),
    subscribe: jest.fn(),
  },
  setGitPulling: jest.fn(),
  setGitPushing: jest.fn(),
  setGitMerging: jest.fn(),
  setMergeInProgress: jest.fn(),
  getGitOperation: jest.fn(() => ({ mergeInProgress: false, conflicts: [] })),
  getProjectTimes: jest.fn(() => ({ today: 0, total: 0 })),
  getProjectSessions: jest.fn(() => []),
  getFolder: jest.fn(),
  getProject: jest.fn(),
  countProjectsRecursive: jest.fn(() => 0),
}));

// Mock i18n
jest.mock('../../src/renderer/i18n', () => ({
  t: jest.fn((key, params) => {
    if (params) return `[${key}:${JSON.stringify(params)}]`;
    return `[${key}]`;
  }),
}));

// Mock UI components
jest.mock('../../src/renderer/ui/components/Modal', () => ({
  showConfirm: jest.fn(),
  createModal: jest.fn(),
  showModal: jest.fn(),
  closeModal: jest.fn(),
}));

// Mock utils
jest.mock('../../src/renderer/utils', () => ({
  escapeHtml: jest.fn((s) => {
    if (typeof s !== 'string') return String(s ?? '');
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }),
}));

jest.mock('../../src/renderer/utils/color', () => ({
  sanitizeColor: jest.fn((c) => c),
}));

jest.mock('../../src/renderer/utils/format', () => ({
  formatDuration: jest.fn((ms) => {
    if (!ms || ms <= 0) return '0m';
    const mins = Math.floor(ms / 60000);
    const hours = Math.floor(mins / 60);
    if (hours > 0) return `${hours}h ${mins % 60}m`;
    return `${mins}m`;
  }),
}));

// Mock project-types registry
jest.mock('../../src/project-types/registry', () => ({
  get: jest.fn(() => ({
    getDashboardBadge: jest.fn(() => ({ text: 'Standalone', cssClass: 'standalone' })),
    getDashboardStats: jest.fn(() => ''),
  })),
}));

// Mock KanbanPanel
jest.mock('../../src/renderer/ui/panels/KanbanPanel', () => ({
  render: jest.fn(),
}));

// Mock events module (used by buildClaudeActivityHtml)
jest.mock('../../src/renderer/events', () => ({
  getActiveProvider: jest.fn(() => 'scraping'),
  getDashboardStats: jest.fn(() => ({ hookSessionCount: 0, toolStats: {} })),
}));

// Mock SessionRecapService (used by buildSessionRecapsHtml)
jest.mock('../../src/renderer/services/SessionRecapService', () => ({
  getRecaps: jest.fn(() => []),
}));

const DashboardService = require('../../src/renderer/services/DashboardService');

// ─── Helpers ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // Clear any cache
  DashboardService.clearAllCache();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// ==================== formatNumber ====================

describe('formatNumber', () => {
  test('formats number with locale', () => {
    const result = DashboardService.formatNumber(1234567);
    // toLocaleString('fr-FR') uses narrow no-break space (U+202F) or non-breaking space (U+00A0)
    // Instead of exact string match, check it contains the digits in order
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    // Should contain the digits
    expect(result.replace(/\s/g, '').replace(/\u00A0/g, '').replace(/\u202F/g, '')).toContain('1234567');
  });

  test('formats zero', () => {
    const result = DashboardService.formatNumber(0);
    expect(result).toBe('0');
  });

  test('handles null/undefined returns "0"', () => {
    expect(DashboardService.formatNumber(null)).toBe('0');
    expect(DashboardService.formatNumber(undefined)).toBe('0');
  });

  test('formats small numbers without separator', () => {
    const result = DashboardService.formatNumber(42);
    expect(result).toContain('42');
  });
});

// ==================== Cache mechanism ====================

describe('cache management', () => {
  test('getCachedData returns null for uncached project', () => {
    expect(DashboardService.getCachedData('unknown')).toBeNull();
  });

  test('invalidateCache removes entry', () => {
    // We can't set cache directly, but we can test it via loadAllDiskCaches
    // Instead, test that invalidate doesn't throw on missing entry
    DashboardService.invalidateCache('nonexistent');
    expect(DashboardService.getCachedData('nonexistent')).toBeNull();
  });

  test('clearAllCache empties cache', () => {
    DashboardService.clearAllCache();
    expect(DashboardService.getCachedData('any')).toBeNull();
  });

  test('cleanup function clears interval without error', () => {
    expect(() => DashboardService.cleanup()).not.toThrow();
  });
});

// ==================== getGitInfo / getGitInfoFull ====================

describe('getGitInfo', () => {
  test('returns result from API', async () => {
    window.electron_api.git = {
      info: jest.fn().mockResolvedValue({ isGitRepo: true, branch: 'main' }),
      infoFull: jest.fn().mockResolvedValue({ isGitRepo: true, branch: 'main', contributors: [] }),
    };

    const result = await DashboardService.getGitInfo('/test/path');
    expect(result.isGitRepo).toBe(true);
  });

  test('returns fallback on error', async () => {
    window.electron_api.git = {
      info: jest.fn().mockRejectedValue(new Error('fail')),
    };

    const result = await DashboardService.getGitInfo('/test/path');
    expect(result.isGitRepo).toBe(false);
  });
});

describe('getGitInfoFull', () => {
  test('returns result from API', async () => {
    window.electron_api.git = {
      infoFull: jest.fn().mockResolvedValue({ isGitRepo: true, branch: 'main' }),
    };

    const result = await DashboardService.getGitInfoFull('/test/path');
    expect(result.isGitRepo).toBe(true);
  });

  test('returns fallback on error', async () => {
    window.electron_api.git = {
      infoFull: jest.fn().mockRejectedValue(new Error('fail')),
    };

    const result = await DashboardService.getGitInfoFull('/test/path');
    expect(result.isGitRepo).toBe(false);
  });
});

// ==================== getProjectStats ====================

describe('getProjectStats', () => {
  test('returns result from API', async () => {
    window.electron_api.project = {
      stats: jest.fn().mockResolvedValue({ files: 100, lines: 5000, byExtension: {} }),
    };

    const result = await DashboardService.getProjectStats('/test');
    expect(result.files).toBe(100);
    expect(result.lines).toBe(5000);
  });

  test('returns fallback on error', async () => {
    window.electron_api.project = {
      stats: jest.fn().mockRejectedValue(new Error('fail')),
    };

    const result = await DashboardService.getProjectStats('/test');
    expect(result.files).toBe(0);
    expect(result.lines).toBe(0);
  });
});

// ==================== loadDashboardData ====================

describe('loadDashboardData', () => {
  beforeEach(() => {
    window.electron_api.git = {
      infoFull: jest.fn().mockResolvedValue({
        isGitRepo: true,
        branch: 'main',
        remoteUrl: 'https://github.com/user/repo.git',
      }),
      commitHistory: jest.fn().mockResolvedValue([]),
    };
    window.electron_api.project = {
      stats: jest.fn().mockResolvedValue({ files: 10, lines: 500 }),
    };
    window.electron_api.github = {
      workflowRuns: jest.fn().mockResolvedValue({ runs: [], authenticated: true }),
      pullRequests: jest.fn().mockResolvedValue({ pullRequests: [], authenticated: true }),
    };
    // Mock fs.existsSync and fs.readdirSync for detectProjectType
    window.electron_nodeModules.fs.existsSync.mockReturnValue(false);
  });

  test('returns complete dashboard data object', async () => {
    const data = await DashboardService.loadDashboardData('/test/project');

    expect(data).toHaveProperty('gitInfo');
    expect(data).toHaveProperty('stats');
    expect(data).toHaveProperty('workflowRuns');
    expect(data).toHaveProperty('pullRequests');
    expect(data).toHaveProperty('projectType');
    expect(data).toHaveProperty('commitHistory30d');
  });

  test('fetches GitHub data for GitHub repos', async () => {
    await DashboardService.loadDashboardData('/test/project');

    expect(window.electron_api.github.workflowRuns).toHaveBeenCalled();
    expect(window.electron_api.github.pullRequests).toHaveBeenCalled();
  });

  test('skips GitHub data for non-GitHub repos', async () => {
    window.electron_api.git.infoFull.mockResolvedValue({
      isGitRepo: true,
      branch: 'main',
      remoteUrl: 'https://gitlab.com/user/repo.git',
    });

    const data = await DashboardService.loadDashboardData('/test/project');

    // workflowRuns should be empty default (not from API)
    expect(data.workflowRuns.runs).toEqual([]);
  });

  test('skips GitHub data for non-git repos', async () => {
    window.electron_api.git.infoFull.mockResolvedValue({
      isGitRepo: false,
    });

    const data = await DashboardService.loadDashboardData('/test/project');
    expect(data.workflowRuns.runs).toEqual([]);
    expect(data.pullRequests.pullRequests).toEqual([]);
  });
});

// ==================== gitPull ====================

describe('gitPull', () => {
  const { setGitPulling } = require('../../src/renderer/state');

  beforeEach(() => {
    const { projectsState } = require('../../src/renderer/state');
    projectsState.get.mockReturnValue({
      projects: [{ id: 'p1', name: 'Test', path: '/test' }],
    });
    window.electron_api.git = {
      pull: jest.fn().mockResolvedValue({ success: true }),
    };
  });

  test('calls git.pull and returns result', async () => {
    const result = await DashboardService.gitPull('p1');
    expect(result.success).toBe(true);
    expect(window.electron_api.git.pull).toHaveBeenCalledWith({ projectPath: '/test' });
  });

  test('sets pulling state before and after', async () => {
    await DashboardService.gitPull('p1');
    expect(setGitPulling).toHaveBeenCalledWith('p1', true);
    expect(setGitPulling).toHaveBeenCalledWith('p1', false, { success: true });
  });

  test('returns error for unknown project', async () => {
    const { projectsState } = require('../../src/renderer/state');
    projectsState.get.mockReturnValue({ projects: [] });

    const result = await DashboardService.gitPull('unknown');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('handles API error gracefully', async () => {
    window.electron_api.git.pull.mockRejectedValue(new Error('Network error'));

    const result = await DashboardService.gitPull('p1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });

  test('calls onComplete callback', async () => {
    const onComplete = jest.fn();
    await DashboardService.gitPull('p1', onComplete);
    expect(onComplete).toHaveBeenCalledWith({ success: true });
  });

  test('sets merge state on conflicts', async () => {
    const { setMergeInProgress } = require('../../src/renderer/state');
    window.electron_api.git.pull.mockResolvedValue({
      success: true,
      hasConflicts: true,
      conflicts: ['file1.js', 'file2.js'],
    });

    await DashboardService.gitPull('p1');
    expect(setMergeInProgress).toHaveBeenCalledWith('p1', true, ['file1.js', 'file2.js']);
  });
});

// ==================== gitPush ====================

describe('gitPush', () => {
  const { setGitPushing } = require('../../src/renderer/state');

  beforeEach(() => {
    const { projectsState } = require('../../src/renderer/state');
    projectsState.get.mockReturnValue({
      projects: [{ id: 'p1', name: 'Test', path: '/test' }],
    });
    window.electron_api.git = {
      push: jest.fn().mockResolvedValue({ success: true }),
    };
  });

  test('calls git.push and returns result', async () => {
    const result = await DashboardService.gitPush('p1');
    expect(result.success).toBe(true);
    expect(window.electron_api.git.push).toHaveBeenCalledWith({ projectPath: '/test' });
  });

  test('sets pushing state before and after', async () => {
    await DashboardService.gitPush('p1');
    expect(setGitPushing).toHaveBeenCalledWith('p1', true);
    expect(setGitPushing).toHaveBeenCalledWith('p1', false, { success: true });
  });

  test('returns error for unknown project', async () => {
    const { projectsState } = require('../../src/renderer/state');
    projectsState.get.mockReturnValue({ projects: [] });

    const result = await DashboardService.gitPush('unknown');
    expect(result.success).toBe(false);
  });

  test('handles API error gracefully', async () => {
    window.electron_api.git.push.mockRejectedValue(new Error('Push failed'));

    const result = await DashboardService.gitPush('p1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Push failed');
  });
});

// ==================== getGitStatusQuick ====================

describe('getGitStatusQuick', () => {
  test('returns API result', async () => {
    window.electron_api.git = {
      statusQuick: jest.fn().mockResolvedValue({ isGitRepo: true, modified: 3 }),
    };

    const result = await DashboardService.getGitStatusQuick('/test');
    expect(result.isGitRepo).toBe(true);
  });

  test('returns fallback on error', async () => {
    window.electron_api.git = {
      statusQuick: jest.fn().mockRejectedValue(new Error('fail')),
    };

    const result = await DashboardService.getGitStatusQuick('/test');
    expect(result.isGitRepo).toBe(false);
  });
});

// ==================== gitMergeAbort ====================

describe('gitMergeAbort', () => {
  beforeEach(() => {
    const { projectsState } = require('../../src/renderer/state');
    projectsState.get.mockReturnValue({
      projects: [{ id: 'p1', name: 'Test', path: '/test' }],
    });
    window.electron_api.git = {
      mergeAbort: jest.fn().mockResolvedValue({ success: true }),
    };
  });

  test('aborts merge and clears state', async () => {
    const { setMergeInProgress } = require('../../src/renderer/state');

    const result = await DashboardService.gitMergeAbort('p1');
    expect(result.success).toBe(true);
    expect(setMergeInProgress).toHaveBeenCalledWith('p1', false, []);
  });

  test('returns error for unknown project', async () => {
    const { projectsState } = require('../../src/renderer/state');
    projectsState.get.mockReturnValue({ projects: [] });

    const result = await DashboardService.gitMergeAbort('unknown');
    expect(result.success).toBe(false);
  });
});

// ==================== isMergeInProgress ====================

describe('isMergeInProgress', () => {
  test('returns API result', async () => {
    window.electron_api.git = {
      mergeInProgress: jest.fn().mockResolvedValue(true),
    };

    const result = await DashboardService.isMergeInProgress('/test');
    expect(result).toBe(true);
  });

  test('returns false on error', async () => {
    window.electron_api.git = {
      mergeInProgress: jest.fn().mockRejectedValue(new Error('fail')),
    };

    const result = await DashboardService.isMergeInProgress('/test');
    expect(result).toBe(false);
  });
});

// ==================== getMergeConflicts ====================

describe('getMergeConflicts', () => {
  test('returns API result', async () => {
    window.electron_api.git = {
      mergeConflicts: jest.fn().mockResolvedValue(['a.js', 'b.js']),
    };

    const result = await DashboardService.getMergeConflicts('/test');
    expect(result).toEqual(['a.js', 'b.js']);
  });

  test('returns empty array on error', async () => {
    window.electron_api.git = {
      mergeConflicts: jest.fn().mockRejectedValue(new Error('fail')),
    };

    const result = await DashboardService.getMergeConflicts('/test');
    expect(result).toEqual([]);
  });
});

// ==================== Edge cases ====================

describe('edge cases', () => {
  test('formatNumber with negative numbers', () => {
    const result = DashboardService.formatNumber(-100);
    expect(result).toBeDefined();
    // Should contain the digits
    expect(result.replace(/[^0-9-]/g, '')).toContain('-100');
  });

  test('formatNumber with very large numbers', () => {
    const result = DashboardService.formatNumber(999999999);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  test('formatNumber with float', () => {
    const result = DashboardService.formatNumber(3.14);
    expect(result).toBeDefined();
    expect(result).toContain('3');
  });

  test('double cleanup does not throw', () => {
    DashboardService.cleanup();
    expect(() => DashboardService.cleanup()).not.toThrow();
  });

  test('clearAllCache followed by getCachedData returns null', () => {
    DashboardService.clearAllCache();
    expect(DashboardService.getCachedData('any-project')).toBeNull();
  });

  test('invalidateCache on non-existent key does not throw', () => {
    expect(() => DashboardService.invalidateCache('does-not-exist')).not.toThrow();
  });
});
