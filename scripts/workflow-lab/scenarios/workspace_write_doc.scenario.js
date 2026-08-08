'use strict';

const fs   = require('fs');
const path = require('path');
const { assert } = require('../sandbox');

/**
 * workspace_write_doc delegates to WorkspaceService, which writes real markdown
 * files under ~/.claude-terminal/workspaces/<id>/. The sandbox's fake $HOME
 * makes that safe, so every scenario runs the node for real and then reads the
 * doc and the index back off disk.
 *
 * One harness detail: WorkspaceService captures its data directory in a module
 * level constant at require() time. Because each scenario gets a *different*
 * fake home, the module has to be evicted from the require cache before every
 * run — otherwise scenario 2 would write into scenario 1's deleted temp dir.
 * (That is a property of the service, not a bug: in the app, $HOME never moves.)
 */

const SERVICE_PATH = require.resolve(
  path.join(__dirname, '..', '..', '..', 'src', 'main', 'services', 'WorkspaceService')
);

/** Drop the cached service so it re-reads os.homedir() for this sandbox. */
function freshService() {
  delete require.cache[SERVICE_PATH];
  return require(SERVICE_PATH);
}

/** Seed workspaces.json in the fake home and return a fresh service handle. */
function seed(sb, workspaces = [{ id: 'ws-1', name: 'My Workspace' }]) {
  sb.dataFile('workspaces.json', { workspaces });
  return freshService();
}

function wsPath(sb, ...segments) {
  return path.join(sb.home, '.claude-terminal', 'workspaces', ...segments);
}

function readIndex(sb, workspaceId = 'ws-1') {
  return JSON.parse(fs.readFileSync(wsPath(sb, workspaceId, 'docs-index.json'), 'utf8')).docs;
}

module.exports = {
  type: 'workspace_write_doc',
  scenarios: [
    {
      name: 'writes the markdown file and indexes it',
      async setup(sb) { seed(sb); },
      config: { workspace: 'ws-1', title: 'Architecture Notes', content: '# Arch\n\nThe main process owns IPC.' },
      assert(out, sb) {
        assert.strictEqual(out.workspaceId, 'ws-1');
        assert.strictEqual(out.title, 'Architecture Notes');
        assert.strictEqual(out.filename, 'architecture-notes.md');

        assert.strictEqual(
          fs.readFileSync(wsPath(sb, 'ws-1', 'docs', 'architecture-notes.md'), 'utf8'),
          '# Arch\n\nThe main process owns IPC.'
        );

        const docs = readIndex(sb);
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(docs[0].id, out.docId);
        assert.strictEqual(docs[0].title, 'Architecture Notes');
        assert.deepStrictEqual(docs[0].tags, []);
        assert.strictEqual(docs[0].summary, '# Arch\n\nThe main process owns IPC.');
        assert.ok(docs[0].createdAt > 0);
        // No .tmp files left behind by the atomic write.
        assert.deepStrictEqual(
          fs.readdirSync(wsPath(sb, 'ws-1', 'docs')), ['architecture-notes.md']
        );
      },
    },
    {
      name: 'strips filesystem-hostile characters out of the filename',
      async setup(sb) { seed(sb); },
      config: { workspace: 'ws-1', title: 'API: Auth/Flow *v2*', content: 'x' },
      assert(out, sb) {
        assert.strictEqual(out.filename, 'api-authflow-v2.md');
        assert.ok(fs.existsSync(wsPath(sb, 'ws-1', 'docs', 'api-authflow-v2.md')));
      },
    },
    {
      name: 'updates an existing doc instead of creating a duplicate',
      async setup(sb) {
        const svc = seed(sb);
        const first = await svc.writeDoc('ws-1', 'Architecture Notes', 'old body');
        sb.firstDocId    = first.id;
        sb.firstCreatedAt = first.createdAt;
      },
      config: { workspace: 'ws-1', title: 'architecture notes', content: 'new body' },
      assert(out, sb) {
        const docs = readIndex(sb);
        assert.strictEqual(docs.length, 1, 'a case-different title must not fork the doc');
        assert.strictEqual(out.docId, sb.firstDocId);
        assert.strictEqual(docs[0].createdAt, sb.firstCreatedAt);
        assert.ok(docs[0].updatedAt >= sb.firstCreatedAt);
        assert.strictEqual(
          fs.readFileSync(wsPath(sb, 'ws-1', 'docs', 'architecture-notes.md'), 'utf8'),
          'new body'
        );
      },
    },
    {
      name: 'attaches comma separated tags to the index entry',
      async setup(sb) { seed(sb); },
      config: { workspace: 'ws-1', title: 'Runbook', content: 'x', tags: 'api,  backend , ' },
      assert(out, sb) {
        assert.deepStrictEqual(readIndex(sb)[0].tags, ['api', 'backend']);
      },
    },
    {
      name: 'merges new tags into existing ones without duplicating',
      async setup(sb) {
        const svc = seed(sb);
        const doc = await svc.writeDoc('ws-1', 'Runbook', 'x');
        const indexPath = wsPath(sb, 'ws-1', 'docs-index.json');
        const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        data.docs.find(d => d.id === doc.id).tags = ['api'];
        fs.writeFileSync(indexPath, JSON.stringify(data, null, 2), 'utf8');
      },
      config: { workspace: 'ws-1', title: 'Runbook', content: 'y', tags: 'api, ops' },
      assert(out, sb) {
        assert.deepStrictEqual(readIndex(sb)[0].tags, ['api', 'ops']);
      },
    },
    {
      name: 'finds the workspace by name, case-insensitively',
      async setup(sb) { seed(sb); },
      config: { workspace: 'my workspace', title: 'Notes', content: 'x' },
      assert(out, sb) {
        assert.strictEqual(out.workspaceId, 'ws-1');
        assert.ok(fs.existsSync(wsPath(sb, 'ws-1', 'docs', 'notes.md')));
      },
    },
    {
      name: 'interpolates $variables into the content',
      async setup(sb) {
        seed(sb);
        sb.vars.set('branch', 'release/1.3');
      },
      config: { workspace: 'ws-1', title: 'Release', content: 'Cut from $branch in $ctx.project' },
      assert(out, sb) {
        assert.strictEqual(
          fs.readFileSync(wsPath(sb, 'ws-1', 'docs', 'release.md'), 'utf8'),
          `Cut from release/1.3 in ${sb.dir}`
        );
      },
    },
    {
      name: 'writes an empty doc rather than refusing blank content',
      async setup(sb) { seed(sb); },
      config: { workspace: 'ws-1', title: 'Placeholder', content: '' },
      assert(out, sb) {
        assert.strictEqual(fs.readFileSync(wsPath(sb, 'ws-1', 'docs', 'placeholder.md'), 'utf8'), '');
        assert.strictEqual(readIndex(sb)[0].summary, '');
      },
    },
    {
      name: 'requires a workspace reference',
      async setup(sb) { seed(sb); },
      config: { workspace: '  ', title: 'Notes', content: 'x' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Workspace id or name is required/i);
      },
    },
    {
      name: 'requires a title',
      async setup(sb) { seed(sb); },
      config: { workspace: 'ws-1', title: '', content: 'x' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Doc title is required/i);
      },
    },
    {
      name: 'reports an unknown workspace instead of creating one',
      async setup(sb) { seed(sb); },
      config: { workspace: 'ws-missing', title: 'Notes', content: 'x' },
      expectThrow: true,
      assert(err, sb) {
        assert.match(err.message, /Workspace "ws-missing" not found/i);
        assert.ok(!fs.existsSync(wsPath(sb, 'ws-missing')), 'no directory may be created');
      },
    },
    {
      name: 'reports an unknown workspace when workspaces.json does not exist',
      async setup(sb) { freshService(); },
      config: { workspace: 'ws-1', title: 'Notes', content: 'x' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /not found/i);
      },
    },
    {
      name: 'refuses a workspace id that escapes the workspaces directory',
      async setup(sb) {
        seed(sb, [{ id: '../../escaped', name: 'Escape Hatch' }]);
      },
      config: { workspace: 'Escape Hatch', title: 'pwn', content: 'x' },
      expectThrow: true,
      assert(err, sb) {
        assert.match(err.message, /Path traversal detected/i);
        assert.ok(!fs.existsSync(path.join(sb.home, 'escaped')), 'nothing may be written outside the workspaces dir');
      },
    },
  ],
};
