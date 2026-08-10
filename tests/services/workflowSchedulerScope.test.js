/**
 * WorkflowScheduler — project scoping and conversation context.
 *
 * Covers the two things a multi-project automation depends on: that an event
 * only reaches the workflows watching its project, and that the payload carries
 * enough to run in that project and scope itself to the conversation that fired.
 */

const WorkflowScheduler = require('../../src/main/services/WorkflowScheduler');

/** A workflow shaped the way WorkflowStorage hands them to the scheduler. */
const wf = (id, trigger) => ({ id, name: id, enabled: true, trigger });

describe('WorkflowScheduler project scoping', () => {
  let scheduler;
  let fired;

  beforeEach(() => {
    scheduler = new WorkflowScheduler();
    fired = [];
    scheduler.dispatch = (id, data) => fired.push({ id, data });
    // No project resolves to a path, so reload() installs no real file/git
    // watchers — these tests are about the in-memory filtering.
    scheduler.resolveProjectPath = () => null;
  });

  afterEach(() => scheduler.destroy());

  const firedIds = () => fired.map(f => f.id);

  describe('chat_message', () => {
    const chatTrigger = (extra) => ({ type: 'chat_message', role: 'assistant', ...extra });

    it('reaches only the workflows watching that project', () => {
      scheduler.reload([
        wf('multi',  chatTrigger({ projectIds: ['api', 'web'] })),
        wf('single', chatTrigger({ projectIds: ['notes'] })),
        wf('any',    chatTrigger({ projectIds: [] })),
      ]);

      scheduler.onChatMessage({ role: 'assistant', text: 'done', projectId: 'web' });

      expect(firedIds().sort()).toEqual(['any', 'multi']);
    });

    it('still honours a legacy scalar projectId', () => {
      // Tasks saved before multi-project watching carry only the scalar, and
      // there is no migration step on disk — the scheduler has to read both.
      scheduler.reload([wf('legacy', chatTrigger({ projectId: 'api' }))]);

      scheduler.onChatMessage({ role: 'assistant', text: 'x', projectId: 'web' });
      expect(fired).toHaveLength(0);

      scheduler.onChatMessage({ role: 'assistant', text: 'x', projectId: 'api' });
      expect(firedIds()).toEqual(['legacy']);
    });

    it('prefers the list when both are present', () => {
      // buildTrigger writes both; the array is the real answer, so a stale
      // scalar must not widen or narrow the scope behind it.
      scheduler.reload([wf('both', chatTrigger({ projectId: 'api', projectIds: ['web'] }))]);

      scheduler.onChatMessage({ role: 'assistant', text: 'x', projectId: 'api' });
      expect(fired).toHaveLength(0);

      scheduler.onChatMessage({ role: 'assistant', text: 'x', projectId: 'web' });
      expect(firedIds()).toEqual(['both']);
    });

    it('forwards the conversation context and the firing project', () => {
      scheduler.reload([wf('t', chatTrigger({ projectIds: ['api'] }))]);

      scheduler.onChatMessage({
        role: 'assistant', text: 'done',
        projectId: 'api', cwd: 'E:/repos/api',
        sessionId: 'chat-1', sdkSessionId: 'sdk-abc',
        files: ['E:/repos/api/a.js'], filesText: '- E:/repos/api/a.js',
      });

      expect(fired[0].data).toMatchObject({
        source: 'chat_message',
        projectId: 'api',
        // What `$trigger.projectPath` resolves against — without it a task set
        // to "run where it fired" lands in the home folder.
        projectPath: 'E:/repos/api',
        sdkSessionId: 'sdk-abc',
        files: ['E:/repos/api/a.js'],
        filesText: '- E:/repos/api/a.js',
      });
    });

    it('describes an empty file list rather than leaving the reference bare', () => {
      scheduler.reload([wf('t', chatTrigger({}))]);
      scheduler.onChatMessage({ role: 'assistant', text: 'x', projectId: 'api' });
      expect(fired[0].data.filesText).toBe('(none recorded)');
    });

    it('still applies the text filter across several projects', () => {
      scheduler.reload([wf('t', chatTrigger({ projectIds: ['api', 'web'], pattern: 'deploy' }))]);

      scheduler.onChatMessage({ role: 'assistant', text: 'all done', projectId: 'web' });
      expect(fired).toHaveLength(0);

      scheduler.onChatMessage({ role: 'assistant', text: 'ready to deploy', projectId: 'web' });
      expect(firedIds()).toEqual(['t']);
    });
  });

  describe('claude_session_end', () => {
    it('scopes to the watched projects and carries the context', () => {
      scheduler.reload([
        wf('watch', { type: 'claude_session_end', projectIds: ['api', 'web'] }),
        wf('other', { type: 'claude_session_end', projectIds: ['notes'] }),
      ]);

      scheduler.onChatSessionEvent({
        event: 'end', status: 'success',
        sessionId: 'chat-1', sdkSessionId: 'sdk-xyz',
        projectId: 'api', cwd: 'E:/repos/api',
        files: ['E:/repos/api/b.js'], filesText: '- E:/repos/api/b.js',
      });

      expect(firedIds()).toEqual(['watch']);
      expect(fired[0].data).toMatchObject({
        projectPath: 'E:/repos/api',
        sdkSessionId: 'sdk-xyz',
        filesText: '- E:/repos/api/b.js',
      });
    });

    it('applies the status filter independently of the project scope', () => {
      scheduler.reload([
        wf('errors', { type: 'claude_session_end', projectIds: ['api', 'web'], statusFilter: 'error' }),
      ]);

      scheduler.onChatSessionEvent({ event: 'end', status: 'success', projectId: 'web' });
      expect(fired).toHaveLength(0);

      scheduler.onChatSessionEvent({ event: 'end', status: 'error', projectId: 'web' });
      expect(firedIds()).toEqual(['errors']);
    });
  });

  describe('other event kinds', () => {
    it('scopes project_opened across several projects', () => {
      scheduler.reload([wf('t', { type: 'project_opened', projectIds: ['api', 'web'] })]);

      scheduler.onProjectOpened({ projectId: 'notes', projectPath: 'E:/n' });
      expect(fired).toHaveLength(0);

      scheduler.onProjectOpened({ projectId: 'web', projectPath: 'E:/w' });
      expect(firedIds()).toEqual(['t']);
    });

    it('scopes terminal_exit_code across several projects', () => {
      scheduler.reload([
        wf('t', { type: 'terminal_exit_code', codeFilter: 'error', projectIds: ['api', 'web'] }),
      ]);

      scheduler.onTerminalExit({ exitCode: 1, projectId: 'notes' });
      expect(fired).toHaveLength(0);

      scheduler.onTerminalExit({ exitCode: 1, projectId: 'api', projectPath: 'E:/a' });
      expect(firedIds()).toEqual(['t']);
      expect(fired[0].data).toMatchObject({ projectId: 'api', projectPath: 'E:/a' });
    });
  });

  describe('per-repository watchers', () => {
    it('installs one watcher per watched project', () => {
      const paths = { api: 'E:/repos/api', web: 'E:/repos/web' };
      scheduler.resolveProjectPath = (id) => paths[id] || null;

      const targets = scheduler._watchTargets({ projectIds: ['api', 'web'] });

      expect(targets).toEqual([
        { projectId: 'api', watchPath: 'E:/repos/api' },
        { projectId: 'web', watchPath: 'E:/repos/web' },
      ]);
    });

    it('drops only the projects it cannot resolve', () => {
      // One deleted project must not take the whole automation down with it.
      scheduler.resolveProjectPath = (id) => (id === 'api' ? 'E:/repos/api' : null);

      expect(scheduler._watchTargets({ projectIds: ['api', 'gone'] }))
        .toEqual([{ projectId: 'api', watchPath: 'E:/repos/api' }]);
    });

    it('lets an explicit watchPath override the project list', () => {
      scheduler.resolveProjectPath = () => 'E:/repos/api';

      expect(scheduler._watchTargets({ watchPath: 'E:/elsewhere', projectIds: ['api'] }))
        .toEqual([{ projectId: '', watchPath: 'E:/elsewhere' }]);
    });
  });
});
