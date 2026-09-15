'use strict';
// Boot the complete app with an old-format profile, without touching the user's
// home, credential vault, cloud or CLI sessions. Native modules are exercised
// separately by runtime-smoke; only the OS credential store is replaced here.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const temporary = process.argv[2];
if (!temporary) throw new Error('Run through scripts/run-runtime-smoke.cjs --upgrade');
os.homedir = () => temporary;
process.env.HOME = temporary; process.env.USERPROFILE = temporary;
app.setPath('userData', path.join(temporary, 'electron'));
app.setPath('home', temporary);
BrowserWindow.prototype.show = function() {};
BrowserWindow.prototype.focus = function() {};
const vault = new Map();
const Module = require('node:module'), originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'keytar') return {
    getPassword: async (service, account) => vault.get(service + ':' + account) || null,
    setPassword: async (service, account, value) => { vault.set(service + ':' + account, value); },
    deletePassword: async (service, account) => vault.delete(service + ':' + account),
    findCredentials: async () => [],
  };
  return originalLoad.call(this, request, ...args);
};
const dataDir = path.join(temporary, '.claude-terminal');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const project = { id: 'upgrade-project', name: 'Upgrade fixture', path: path.join(temporary, 'project'), type: 'webapp' };
fs.mkdirSync(project.path, { recursive: true });
write(path.join(project.path, 'package.json'), { name: 'upgrade-fixture', version: '1.0.0', scripts: {} });
const settings = { setupCompleted: true, language: 'fr', theme: 'dark', telemetryEnabled: false, hooksEnabled: false, discordRpcEnabled: false, remoteEnabled: false, cloudEnabled: false, upgradeSentinel: 'preserved' };
write(path.join(dataDir, 'settings.json'), settings);
write(path.join(dataDir, 'terminal-sessions.json'), {});
write(path.join(dataDir, 'model-catalog.json'), { fetchedAt: Date.now(), primary: [{ value: 'haiku', displayName: 'Test model' }] });
write(path.join(dataDir, 'projects.json'), { projects: [project], folders: [] });
write(path.join(dataDir, 'workflows/definitions.json'), [{ id: 'old-workflow', name: 'Missing trigger fixture', enabled: true, trigger: { type: 'file_change', projectId: 'removed-project' }, steps: [] }]);
write(path.join(dataDir, 'databases.json'), [{ id: 'old-db', type: 'mongodb', connectionString: 'mongodb://alice:old%40secret@host1,host2/db?replicaSet=rs', name: 'Preserved connection' }]);
const legacyMcp = { customSetting: 'keep', mcpServers: { other: { command: 'preserve' }, 'claude-terminal': { env: { CT_DB_PASS_old: 'old-secret-copy' } } } };
write(path.join(temporary, '.claude.json'), legacyMcp);
write(path.join(temporary, '.claude.json.backup'), legacyMcp);
const errors = [];
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, file, error) => errors.push(`${file}: ${error.message}`));
  contents.on('console-message', details => { if (details.level === 'error') console.error('Renderer:', details.message); });
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(action, message) {
  const deadline = Date.now() + 25000;
  while (!(await action())) { if (Date.now() > deadline) throw new Error(message); await wait(50); }
}
const timeout = setTimeout(() => { console.error('Upgrade smoke timed out'); app.exit(1); }, 70000);
require('../main.js');
app.whenReady().then(async () => {
  const start = Date.now(); let window;
  await until(() => (window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html'))) && !window.webContents.isLoading(), 'Main document did not load');
  window.setSize(1400, 950); window.webContents.setBackgroundThrottling(false);
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  const js = code => window.webContents.executeJavaScript(code);
  await until(() => js('!!document.querySelector(".project-item")'), 'Legacy project did not appear');
  await until(() => !fs.readFileSync(path.join(dataDir, 'databases.json'), 'utf8').includes('old%40secret'), 'Database migration did not finish');
  const migrated = JSON.parse(fs.readFileSync(path.join(dataDir, 'databases.json'), 'utf8'))[0];
  assert.equal(migrated.connectionString, 'mongodb://host1,host2/db?replicaSet=rs');
  assert.equal(vault.get('claude-terminal-db:db-old-db'), 'old@secret');
  await until(() => JSON.parse(fs.readFileSync(path.join(temporary, '.claude.json'), 'utf8')).mcpServers['claude-terminal'].command, 'MCP migration did not finish');
  assert.equal(JSON.parse(fs.readFileSync(path.join(temporary, '.claude.json'), 'utf8')).mcpServers.other.command, 'preserve');
  assert(!fs.readFileSync(path.join(temporary, '.claude.json.backup'), 'utf8').includes('old-secret-copy'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).upgradeSentinel, 'preserved');
  console.log(`PASS full sandboxed app boot and legacy profile migration (${Date.now() - start} ms)`);
  await js('document.getElementById("btn-settings").click()');
  await until(() => js('typeof document.querySelector(".settings-search input")?.oninput === "function"'), 'Settings search did not load');
  await js(`(() => { const input = document.querySelector('.settings-search input'); input.value = document.querySelector('[data-section="secret-backups"] .settings-label > div').textContent; input.dispatchEvent(new Event('input')); })()`);
  assert(await js('document.querySelectorAll(".settings-search-match .settings-row:not(.settings-search-hidden)").length > 0'));
  await js("document.querySelector('#settings-search-clear').click()");
  assert(await js("document.activeElement.id === 'settings-search-input' && document.activeElement.value === ''"));
  await wait(200);
  if (process.env.CT_UPGRADE_SCREENSHOT) fs.writeFileSync(process.env.CT_UPGRADE_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
  await js('document.querySelector(\'.nav-tab[data-tab="control-tower"]\').click()');
  await until(() => js('document.querySelector("#ct-incidents")?.textContent.includes("Missing trigger fixture")'), 'Unavailable workflow trigger missing from Control Tower');
  const wizard = require('../src/main/windows/SetupWizardWindow').createSetupWizardWindow({ onComplete() {}, onSkip() {} });
  await until(() => !wizard.webContents.isLoading(), 'Setup wizard did not load');
  assert.equal(wizard.webContents.getLastWebPreferences().sandbox, true);
  assert(await wizard.webContents.executeJavaScript("!!window.electron_api && typeof window.electron_nodeModules.fs.readFileSync === 'function'"));
  assert.deepEqual(errors, []);
  console.log('PASS shipped settings search, operational alerts and sandboxed setup wizard');
  clearTimeout(timeout); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
