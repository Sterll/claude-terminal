// tests/panels/worktreesDashboard.test.js
'use strict';

const { groupWorktreesByRepo, matchProjectToWorktree } = require('../../src/renderer/ui/panels/WorktreesDashboard');

describe('groupWorktreesByRepo', () => {
  it('groups worktrees that share the same main repo path', () => {
    const results = [
      {
        project: { id: 'p1', path: '/repos/app', name: 'app' },
        worktrees: [
          { path: '/repos/app', branch: 'main', isMain: true },
          { path: '/repos/app-feat', branch: 'feat/x', isMain: false }
        ]
      },
      {
        project: { id: 'p2', path: '/repos/app-feat', name: 'app-feat' },
        worktrees: [
          { path: '/repos/app', branch: 'main', isMain: true },
          { path: '/repos/app-feat', branch: 'feat/x', isMain: false }
        ]
      }
    ];
    const groups = groupWorktreesByRepo(results);
    expect(groups).toHaveLength(1);
    expect(groups[0].repoPath).toBe('/repos/app');
    expect(groups[0].worktrees).toHaveLength(2);
  });

  it('returns separate groups for different repos', () => {
    const results = [
      { project: { id: 'p1', path: '/repos/a', name: 'a' }, worktrees: [{ path: '/repos/a', branch: 'main', isMain: true }] },
      { project: { id: 'p2', path: '/repos/b', name: 'b' }, worktrees: [{ path: '/repos/b', branch: 'main', isMain: true }] }
    ];
    expect(groupWorktreesByRepo(results)).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(groupWorktreesByRepo([])).toEqual([]);
  });

  it('skips entries with no worktrees', () => {
    const results = [
      { project: { id: 'p1', path: '/repos/a', name: 'a' }, worktrees: [] }
    ];
    expect(groupWorktreesByRepo(results)).toHaveLength(0);
  });
});

describe('matchProjectToWorktree', () => {
  const projects = [
    { id: 'p1', path: '/repos/app' },
    { id: 'p2', path: '/repos/app-feat', isWorktree: true }
  ];

  it('finds a project by exact path', () => {
    expect(matchProjectToWorktree('/repos/app-feat', projects)?.id).toBe('p2');
  });

  it('normalises backslashes for Windows paths', () => {
    expect(matchProjectToWorktree('\\repos\\app', projects)?.id).toBe('p1');
  });

  it('returns null when no project matches', () => {
    expect(matchProjectToWorktree('/repos/unknown', projects)).toBeNull();
  });
});
