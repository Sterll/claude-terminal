/** @jest-environment node */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');
let temporary, security;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-boundary-'));
  jest.spyOn(os, 'homedir').mockReturnValue(temporary);
  jest.resetModules(); security = require('../../src/main/utils/rendererSecurity');
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(temporary, { recursive: true, force: true }); });
const contents = url => Object.assign(new EventEmitter(), { mainFrame: { url }, getURL: () => url, setWindowOpenHandler: jest.fn() });
test('only registered top-level documents can invoke privileged IPC', async () => {
  const page = path.join(temporary, 'index.html'), url = pathToFileURL(page).href;
  const wc = contents(url), other = contents(url);
  security.guardWindow({ webContents: wc }, page);
  const event = { sender: wc, senderFrame: wc.mainFrame };
  expect(security.isTrusted(event)).toBe(true);
  expect(security.isTrusted({ sender: other, senderFrame: other.mainFrame })).toBe(false);
  expect(security.isTrusted({ sender: wc, senderFrame: { url } })).toBe(false);
  wc.mainFrame.url = pathToFileURL(path.join(temporary, 'other.html')).href;
  expect(security.isTrusted(event)).toBe(false);
  const blocked = { preventDefault: jest.fn() }; wc.emit('will-navigate', blocked, wc.mainFrame.url);
  expect(blocked.preventDefault).toHaveBeenCalled();
});
test('new files below symlinked ancestors cannot escape a granted project', () => {
  const project = path.join(temporary, 'project'), outside = path.join(temporary, 'outside');
  fs.mkdirSync(project); fs.mkdirSync(outside);
  security.grant(project);
  expect(security.permitted(path.join(project, 'new/file'), true)).toBe(true);
  expect(security.permitted(outside, true)).toBe(false);
  fs.symlinkSync(outside, path.join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(security.permitted(path.join(project, 'link/new-file'), true)).toBe(false);
  security.grant(outside, { write: false });
  expect(security.permitted(outside)).toBe(true);
  expect(security.permitted(outside, true)).toBe(false);
});
test('equivalent file URL encoding keeps the exact document trusted', () => {
  const page = path.join(temporary, 'app~1', 'index.html');
  const chromiumUrl = pathToFileURL(page).href.replace(/%7E/gi, '~');
  const wc = contents(chromiumUrl);
  security.guardWindow({ webContents: wc }, page);
  expect(security.isTrusted({ sender: wc, senderFrame: wc.mainFrame })).toBe(true);
  const navigation = { preventDefault: jest.fn() };
  wc.emit('will-navigate', navigation, chromiumUrl);
  expect(navigation.preventDefault).not.toHaveBeenCalled();
  wc.mainFrame.url = chromiumUrl.replace('index.html', 'other.html');
  expect(security.isTrusted({ sender: wc, senderFrame: wc.mainFrame })).toBe(false);
});
test('microphone permission is limited to the main application document', () => {
  const page = path.join(temporary, 'index.html'), url = pathToFileURL(page).href;
  const wc = contents(url); security.guardWindow({ webContents: wc }, page);
  expect(security.allowMicrophone(wc, { mediaTypes: ['audio'], requestingUrl: url })).toBe(true);
  expect(security.allowMicrophone(wc, { mediaTypes: ['audio', 'video'], requestingUrl: url })).toBe(false);
  expect(security.allowMicrophone(wc, { mediaType: 'audio', isMainFrame: false })).toBe(false);
  expect(security.allowMicrophone(wc, { mediaTypes: ['audio'], requestingUrl: 'file:///untrusted.html' })).toBe(false);
});
test('guarded IPC rejects an untrusted sender before executing the handler', () => {
  const handlers = new Map();
  const ipc = new EventEmitter(); ipc.handle = (channel, fn) => handlers.set(channel, fn);
  security.install(ipc);
  const handler = jest.fn(); ipc.handle('dangerous-action', handler);
  expect(() => handlers.get('dangerous-action')({})).toThrow(/Untrusted/);
  expect(handler).not.toHaveBeenCalled();
});

// Remote (SSH) projects: design/remote-ssh.md section 7.1. A remote project's
// path is an ssh-remote:// URI, and nothing about it may ever become a local
// grant, whatever platform the client runs on.
describe('remote projects are never granted to the renderer', () => {
  const URI = 'ssh-remote://abcd1234/home/yanis/api';
  const remote = { id: 'r1', name: 'api', type: 'general', path: URI, remote: { profileId: 'abcd1234', path: '/home/yanis/api', hostLabel: 'yanis@build' } };

  test('projectGrantPaths skips remote projects, their worktrees, and a hand-edited bare remote path', () => {
    const local = path.join(temporary, 'local');
    const paths = security.projectGrantPaths({
      projects: [
        { id: 'l1', path: local, worktrees: [{ path: `${local}-wt` }] },
        { ...remote, worktrees: [{ path: 'ssh-remote://abcd1234/home/yanis/api-wt' }] },
        // A remote block with a bare POSIX path: on Windows that would resolve
        // onto the current drive. Skipped for the block, not for the shape.
        { id: 'r2', path: '/home/yanis/other', remote: { profileId: 'abcd1234', path: '/home/yanis/other' } },
        // A URI without the block (a project written by an older build).
        { id: 'r3', path: 'ssh-remote://abcd1234/' },
      ],
    });
    expect(paths).toEqual([local, `${local}-wt`]);
  });

  test('install() grants the local project and nothing remote', () => {
    const local = path.join(temporary, 'local');
    fs.mkdirSync(local);
    fs.mkdirSync(path.join(temporary, '.claude-terminal'));
    fs.writeFileSync(path.join(temporary, '.claude-terminal', 'projects.json'), JSON.stringify({
      projects: [
        { id: 'l1', path: local },
        remote,
        { id: 'r2', path: '/home/yanis/other', remote: { profileId: 'abcd1234', path: '/home/yanis/other' } },
      ],
    }));
    const handlers = new Map();
    const ipc = new EventEmitter();
    ipc.handle = (channel, fn) => handlers.set(channel, fn);
    security.install(ipc);
    expect(security.permitted(path.join(local, 'file.txt'), true)).toBe(true);
    expect(security.permitted(URI)).toBe(false);
    expect(security.permitted(URI, true)).toBe(false);
    expect(security.permitted(`${URI}/src/index.js`)).toBe(false);
    // The bare path of the second remote project, as the local OS would read it.
    expect(security.permitted(path.resolve('/home/yanis/other'), true)).toBe(false);
  });

  test.each(['win32', 'posix'])('on %s, a URI is not absolute, so grant() ignores it and permitted() refuses it', (flavor) => {
    const flavored = path[flavor];
    expect(flavored.isAbsolute(URI)).toBe(false);
    expect(flavored.isAbsolute('ssh-remote://abcd1234/')).toBe(false);
    jest.resetModules();
    jest.doMock('path', () => jest.requireActual('path')[flavor]);
    try {
      const flavoredSecurity = require('../../src/main/utils/rendererSecurity');
      flavoredSecurity.grant(URI);
      flavoredSecurity.grant('ssh-remote://abcd1234/');
      expect(flavoredSecurity.permitted(URI)).toBe(false);
      expect(flavoredSecurity.permitted(URI, true)).toBe(false);
      expect(flavoredSecurity.permitted('ssh-remote://abcd1234/etc/passwd')).toBe(false);
      expect(flavoredSecurity.projectGrantPaths({ projects: [remote] })).toEqual([]);
    } finally {
      jest.dontMock('path');
      jest.resetModules();
    }
  });
});
