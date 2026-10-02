/**
 * MCP project tools on remote (SSH) projects (design/remote-ssh.md section 8).
 *
 * The MCP server reads local disk; a remote project's files live on another
 * machine that only the app reaches. The tools have to say so, rather than
 * answer "path not found" about a URI, and project_create must not invent a
 * remote project, since the SSH host profiles belong to the app alone.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-proj-remote-'));
let projects;

const REMOTE = {
  id: 'r1',
  name: 'api',
  type: 'general',
  path: 'ssh-remote://abcd1234/home/yanis/api',
  remote: { profileId: 'abcd1234', path: '/home/yanis/api', hostLabel: 'yanis@build.example.com' },
};

beforeAll(() => {
  process.env.CT_DATA_DIR = DATA_DIR;
  projects = require('../../resources/mcp-servers/tools/projects.js');
});

afterAll(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify({ projects: [REMOTE], folders: [], rootOrder: ['r1'] }), 'utf8');
});

const textOf = (r) => r.content[0].text;

test('project_info names the host and says the files are not readable here', async () => {
  const res = await projects.handle('project_info', { project: 'api' });
  expect(res.isError).toBeFalsy();
  expect(textOf(res)).toContain('Remote: yanis@build.example.com:/home/yanis/api');
  expect(textOf(res)).toContain('remote project on yanis@build.example.com:/home/yanis/api');
  expect(textOf(res)).toContain('not readable from the MCP server');
  expect(textOf(res)).not.toMatch(/not found/i);
});

test.each(['project_todos', 'project_stats'])('%s answers with the remote message, not "path not found"', async (tool) => {
  const res = await projects.handle(tool, { project: 'r1' });
  expect(res.isError).toBe(true);
  expect(textOf(res)).toContain('remote project on yanis@build.example.com:/home/yanis/api');
  expect(textOf(res)).not.toMatch(/path not found/i);
});

test('project_create refuses a remote URI', async () => {
  const res = await projects.handle('project_create', { path: 'ssh-remote://abcd1234/home/yanis/other' });
  expect(res.isError).toBe(true);
  expect(textOf(res)).toMatch(/Remote projects cannot be created from the MCP server/);
  const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'projects.json'), 'utf8'));
  expect(data.projects).toHaveLength(1);
});

test('project_update cannot turn a remote project into a project type that reads local files', async () => {
  const res = await projects.handle('project_update', { project: 'api', type: 'webapp' });
  expect(res.isError).toBe(true);
  const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'projects.json'), 'utf8'));
  expect(data.projects[0].type).toBe('general');
});
