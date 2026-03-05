// tests/panels/worktreesDashboard.test.js
'use strict';

const { groupWorktreesByRepo, matchProjectToWorktree } = require('../../src/renderer/ui/panels/WorktreesDashboard');

describe('groupWorktreesByRepo', () => {
  test('groups worktrees that share the same main repo path', () => {
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
    expect(groups[0].worktrees.map(w => w.path)).toEqual(
      expect.arrayContaining(['/repos/app', '/repos/app-feat'])
    );
    expect(groups[0].repoName).toBe('app');
  });

  test('returns separate groups for different repos', () => {
    const results = [
      { project: { id: 'p1', path: '/repos/a', name: 'a' }, worktrees: [{ path: '/repos/a', branch: 'main', isMain: true }] },
      { project: { id: 'p2', path: '/repos/b', name: 'b' }, worktrees: [{ path: '/repos/b', branch: 'main', isMain: true }] }
    ];
    expect(groupWorktreesByRepo(results)).toHaveLength(2);
  });

  test('returns empty array for empty input', () => {
    expect(groupWorktreesByRepo([])).toEqual([]);
  });

  test('skips entries with no worktrees', () => {
    const results = [
      { project: { id: 'p1', path: '/repos/a', name: 'a' }, worktrees: [] }
    ];
    expect(groupWorktreesByRepo(results)).toHaveLength(0);
  });

  test('skips entries with null worktrees', () => {
    const results = [{ project: { id: 'p1', path: '/repos/a', name: 'a' }, worktrees: null }];
    expect(groupWorktreesByRepo(results)).toHaveLength(0);
  });
});

describe('matchProjectToWorktree', () => {
  const projects = [
    { id: 'p1', path: '/repos/app' },
    { id: 'p2', path: '/repos/app-feat', isWorktree: true }
  ];

  test('finds a project by exact path', () => {
    expect(matchProjectToWorktree('/repos/app-feat', projects)?.id).toBe('p2');
  });

  test('normalises backslashes for Windows paths', () => {
    expect(matchProjectToWorktree('\\repos\\app', projects)?.id).toBe('p1');
  });

  test('returns null when no project matches', () => {
    expect(matchProjectToWorktree('/repos/unknown', projects)).toBeNull();
  });

  test('handles Windows drive-letter paths', () => {
    const winProjects = [{ id: 'p1', path: 'C:\\repos\\app' }];
    expect(matchProjectToWorktree('C:\\repos\\app', winProjects)?.id).toBe('p1');
  });
});
