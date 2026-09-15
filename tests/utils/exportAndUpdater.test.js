/** @jest-environment node */
const fs = require('fs');
const path = require('path');
const os = require('os');
const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-export-'));
jest.mock('../../src/main/utils/paths', () => ({ settingsFile: mockDir + '/settings.json' }));
jest.mock('electron', () => ({ app: { getPath: () => mockDir + '/data', getVersion: jest.fn() } }));
jest.mock('electron-updater', () => ({ autoUpdater: {} }));
const { zipProject, getProjectFiles } = require('../../src/main/utils/zipProject');
const extractZip = require('../../src/shared/extractZip');
const updater = require('../../src/main/services/UpdaterService');
afterAll(() => fs.rmSync(mockDir, { recursive: true, force: true }));
test('exports Unicode, whitespace and newline filenames exactly', async () => {
  const repo = path.join(mockDir, 'repo'); fs.mkdirSync(repo);
  require('child_process').execFileSync('git', ['init', '-q', repo]);
  const names = ['été.txt', ' spaced.txt', ...(process.platform === 'win32' ? [] : ['two\nlines.txt'])];
  for (const name of names) fs.writeFileSync(path.join(repo, name), name);
  fs.writeFileSync(path.join(repo, '.env'), 'secret');
  expect(getProjectFiles(repo)).toEqual(expect.arrayContaining(names));
  const zip = path.join(mockDir, 'project.zip'); await zipProject(repo, zip);
  const output = path.join(mockDir, 'extracted'); await extractZip(zip, { dir: output });
  expect(fs.readdirSync(output).sort()).toEqual(names.sort());
});
test.each([
  ['1.9.0', '1.10.0', false], ['1.3.2-BLE.7', '1.3.2-BLE.10', false],
  ['1.3.2-BLE.10', '1.3.2-BLE.7', true], ['1.3.2', '1.3.2-BLE.10', true],
])('cleans %s versus pending %s only when already installed', (current, pending, removes) => {
  require('electron').app.getVersion.mockReturnValue(current);
  const dir = path.join(mockDir, 'claude-terminal-updater/pending'); fs.mkdirSync(dir, { recursive: true });
  const info = path.join(dir, 'update-info.json'); fs.writeFileSync(info, JSON.stringify({ fileName: `Claude-Terminal-${pending}.exe` }));
  updater.clearStalePendingCache(); expect(fs.existsSync(info)).toBe(!removes);
});
