/**
 * The @git and @todos mentions of a chat (chat/projectMentions).
 *
 * A local project reads them as it always did. A remote (SSH) project used to
 * go through the same calls with nothing to say whether its host could
 * answer; now its URI goes to the remote git primitives and the remote TODO
 * scan while the host is connected, and the mention fails closed, without
 * asking the host anything, while it is not: Claude is told the data lives on
 * the host instead of being told there are no changes or no TODOs. The two
 * project hints of the composer (rotating placeholder, follow-up chips) skip
 * a remote project whose host is away rather than connect it.
 */

const {
  createProjectMentions,
  projectPathOf,
} = require('../../src/renderer/ui/components/chat/projectMentions');

const URI = 'ssh-remote://abcd1234/home/yanis/api';
const REMOTE = {
  id: 'r1', name: 'api', type: 'general', path: URI,
  remote: { profileId: 'abcd1234', path: '/home/yanis/api', hostLabel: 'yanis@build' },
};
const LOCAL = { id: 'l1', name: 'app', path: '/code/app' };

function makeApi({ files = [{ path: 'src/a.js' }, { path: 'b.txt' }], todos = [{ type: 'TODO', file: 'src/a.js', line: 3, text: 'tidy up' }], status } = {}) {
  return {
    git: {
      statusDetailed: jest.fn(async () => status || { success: true, files }),
      fileDiff: jest.fn(async ({ filePath }) => (filePath === 'src/a.js' ? '@@ -1 +1 @@\n-a\n+b\n' : '')),
    },
    project: { scanTodos: jest.fn(async () => todos) },
  };
}

function hosts(state) {
  let current = state;
  return {
    getProjectHost: jest.fn((p) => (p && p.remote ? { profileId: 'abcd1234', hostLabel: 'yanis@build', state: current } : null)),
    set: (next) => { current = next; },
  };
}

describe('projectPathOf', () => {
  test('a local project keeps its path, a remote one its URI', () => {
    expect(projectPathOf(LOCAL)).toBe('/code/app');
    expect(projectPathOf(REMOTE)).toBe(URI);
  });

  test('a remote record with a bare path gets its URI back from its remote block', () => {
    expect(projectPathOf({ ...REMOTE, path: '/home/yanis/api' })).toBe(URI);
  });
});

describe('a local project reads as before', () => {
  test('@git sends the diff of each changed file', async () => {
    const api = makeApi();
    const h = hosts('idle');
    const { resolveGit } = createProjectMentions({ api, getProjectHost: h.getProjectHost });
    const text = await resolveGit(LOCAL);
    expect(api.git.statusDetailed).toHaveBeenCalledWith({ projectPath: '/code/app' });
    expect(api.git.fileDiff).toHaveBeenCalledWith({ projectPath: '/code/app', filePath: 'src/a.js' });
    expect(text).toBe('Git Changes (2 files):\n\n--- src/a.js ---\n@@ -1 +1 @@\n-a\n+b\n');
  });

  test('@git with nothing changed, and @git that fails', async () => {
    const h = hosts('idle');
    expect(await createProjectMentions({ api: makeApi({ files: [] }), getProjectHost: h.getProjectHost }).resolveGit(LOCAL)).toBe('[No git changes detected]');
    const api = makeApi();
    api.git.statusDetailed.mockRejectedValueOnce(new Error('boom'));
    expect(await createProjectMentions({ api, getProjectHost: h.getProjectHost }).resolveGit(LOCAL)).toBe('[Error fetching git diff]');
  });

  test('@todos lists the scan, or says there is none', async () => {
    const h = hosts('idle');
    const api = makeApi();
    const { resolveTodos } = createProjectMentions({ api, getProjectHost: h.getProjectHost });
    expect(await resolveTodos(LOCAL)).toBe('TODO Items (1 found):\n\nTODO [src/a.js:3]: tidy up');
    expect(api.project.scanTodos).toHaveBeenCalledWith('/code/app');
    expect(await createProjectMentions({ api: makeApi({ todos: [] }), getProjectHost: h.getProjectHost }).resolveTodos(LOCAL)).toBe('[No TODOs found in project]');
  });

  test('a local project may always be read for hints', () => {
    expect(createProjectMentions({ api: makeApi(), getProjectHost: hosts('idle').getProjectHost }).mayRead(LOCAL)).toBe(true);
  });
});

describe('a remote project whose host is connected is read on the host', () => {
  test('@git goes to the remote git primitives with the URI', async () => {
    const api = makeApi();
    const { resolveGit } = createProjectMentions({ api, getProjectHost: hosts('connected').getProjectHost });
    const text = await resolveGit(REMOTE);
    expect(api.git.statusDetailed).toHaveBeenCalledWith({ projectPath: URI });
    expect(api.git.fileDiff).toHaveBeenCalledWith({ projectPath: URI, filePath: 'src/a.js' });
    expect(text).toContain('--- src/a.js ---');
  });

  test('@todos goes to the remote TODO scan with the URI', async () => {
    const api = makeApi();
    const { resolveTodos } = createProjectMentions({ api, getProjectHost: hosts('connected').getProjectHost });
    expect(await resolveTodos(REMOTE)).toBe('TODO Items (1 found):\n\nTODO [src/a.js:3]: tidy up');
    expect(api.project.scanTodos).toHaveBeenCalledWith(URI);
  });

  test('the hints may read it', () => {
    expect(createProjectMentions({ api: makeApi(), getProjectHost: hosts('connected').getProjectHost }).mayRead(REMOTE)).toBe(true);
  });
});

describe('a remote project whose host is not connected fails closed', () => {
  test.each(['idle', 'reconnecting', 'offline', 'authFailed', 'unconfigured'])('%s: no request, and Claude is told where the data is', async (state) => {
    const api = makeApi();
    const mentions = createProjectMentions({ api, getProjectHost: hosts(state).getProjectHost });
    const git = await mentions.resolveGit(REMOTE);
    const todos = await mentions.resolveTodos(REMOTE);
    expect(api.git.statusDetailed).not.toHaveBeenCalled();
    expect(api.git.fileDiff).not.toHaveBeenCalled();
    expect(api.project.scanTodos).not.toHaveBeenCalled();
    expect(git).toMatch(/git changes of this project live on yanis@build, which is not connected/);
    expect(todos).toMatch(/TODOs of this project live on yanis@build, which is not connected/);
    expect(git).not.toMatch(/No git changes/);
    expect(todos).not.toMatch(/No TODOs/);
    expect(mentions.mayRead(REMOTE)).toBe(false);
  });

  test('a host that drops during @git: the disconnected answer is not read as a clean tree', async () => {
    const api = makeApi({ status: { success: false, error: 'host away', reason: 'disconnected' } });
    const text = await createProjectMentions({ api, getProjectHost: hosts('connected').getProjectHost }).resolveGit(REMOTE);
    expect(text).toMatch(/live on yanis@build, which is not connected/);
  });

  test('a host that drops during @todos: the empty scan is not read as no TODOs', async () => {
    const h = hosts('connected');
    const api = makeApi({ todos: [] });
    api.project.scanTodos.mockImplementation(async () => { h.set('reconnecting'); return []; });
    const text = await createProjectMentions({ api, getProjectHost: h.getProjectHost }).resolveTodos(REMOTE);
    expect(text).toMatch(/TODOs of this project live on yanis@build/);
  });
});

describe('the composer hints leave an unreachable host alone', () => {
  test('the rotating placeholder does not scan when it may not read', async () => {
    const { createContextSuggestions } = require('../../src/renderer/ui/components/chat/contextSuggestions');
    const api = makeApi();
    const input = { setPlaceholder: jest.fn(), isEmpty: () => true };
    const hint = createContextSuggestions(api, REMOTE, input, () => 'Ask', () => false);
    await hint.refresh();
    expect(api.project.scanTodos).not.toHaveBeenCalled();
    expect(api.git.statusDetailed).not.toHaveBeenCalled();
    hint.stop();
  });

  test('with no hint to show, a refresh still puts the default placeholder back', async () => {
    // Every turn sets "queue a follow-up" and relies on this refresh to undo
    // it: a clean work tree, or a host that may not be read, used to leave it
    // on an idle composer for good.
    const { createContextSuggestions } = require('../../src/renderer/ui/components/chat/contextSuggestions');
    const api = makeApi();
    api.git.statusDetailed.mockImplementation(async () => ({ modified: [], staged: [], untracked: [] }));
    for (const [project, mayRead] of [[LOCAL, () => true], [REMOTE, () => false]]) {
      const input = { setPlaceholder: jest.fn(), isEmpty: () => true };
      const hint = createContextSuggestions(api, project, input, () => 'Ask', mayRead);
      await hint.refresh();
      expect(input.setPlaceholder).toHaveBeenLastCalledWith('Ask');
      hint.stop();
    }
  });

  test('the follow-up chips do not scan when they may not read, and still do for a local project', async () => {
    const { createFollowupChips } = require('../../src/renderer/ui/components/chat/followupChips');
    const api = makeApi();
    const el = document.createElement('div');
    const input = { isEmpty: () => true, onInput: () => () => {} };
    const remoteChips = createFollowupChips(api, el, input, REMOTE, () => false);
    await remoteChips.flush();
    expect(api.project.scanTodos).not.toHaveBeenCalled();
    const localChips = createFollowupChips(api, el, input, LOCAL);
    await localChips.flush();
    expect(api.project.scanTodos).toHaveBeenCalledWith('/code/app');
  });
});
