/** @jest-environment node */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
jest.mock('chokidar', () => ({ watch: jest.fn(() => Object.assign(new (require('events').EventEmitter)(), { close: jest.fn() })) }));
const Scheduler = require('../../src/main/services/WorkflowScheduler');
let scheduler, dir;
beforeEach(() => { scheduler = new Scheduler(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-trigger-')); scheduler.resolveProjectPath = id => id === 'project' ? dir : null; });
afterEach(() => { scheduler.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
const wf = (id, trigger) => ({ id, enabled: true, trigger });
test('reports missing projects and invalid cron or regex instead of silent disablement', () => {
  scheduler.reload([wf('missing', { type: 'file_change', projectIds: ['removed'] }), wf('cron', { type: 'cron', value: 'bad' }), wf('regex', { type: 'chat_message', pattern: '[', matchMode: 'regex' })]);
  expect(scheduler.getTriggerStatuses().map(status => status.status)).toEqual(['error', 'error', 'error']);
  scheduler.reload([]); expect(scheduler.getTriggerStatuses()).toEqual([]);
});
test('error stays visible through ready, retry replaces only the requested workflow watcher', () => {
  scheduler.reload([wf('a', { type: 'file_change', projectId: 'project' }), wf('b', { type: 'file_change', projectId: 'project' })]);
  const first = scheduler._fileWatchers.get('a::project').watcher, other = scheduler._fileWatchers.get('b::project').watcher;
  expect(scheduler.getTriggerStatuses()[0].status).toBe('starting');
  first.emit('error', new Error('Watch limit reached')); first.emit('ready');
  expect(scheduler.getTriggerStatuses()[0]).toMatchObject({ status: 'error', error: 'Watch limit reached' });
  scheduler.retryTrigger('a');
  expect(first.close).toHaveBeenCalled(); expect(other.close).not.toHaveBeenCalled();
  scheduler._fileWatchers.get('a::project').watcher.emit('ready');
  expect(scheduler.getTriggerStatuses()[0].status).toBe('ready');
  expect(() => scheduler.retryTrigger('missing')).toThrow();
});
test('Git worktrees watch their own HEAD log and the shared remotes log', () => {
  const gitDir = path.join(dir, 'shared', 'worktrees', 'topic'); fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: shared/worktrees/topic\n');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/topic\n');
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  scheduler.reload([wf('git', { type: 'git_event', projectId: 'project' })]);
  expect(require('chokidar').watch).toHaveBeenLastCalledWith([path.join(gitDir, 'logs', 'HEAD'), path.join(dir, 'shared', 'logs', 'refs', 'remotes')], expect.any(Object));
});
