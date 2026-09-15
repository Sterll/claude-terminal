'use strict';
// Real Chromium layout for the shipped ChatView; all account/history APIs are
// fixtures. No CLI session, credential store or production profile is used.
module.exports = async function chatScrollSmoke(temporary) {
  const fs = require('node:fs'), path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { BrowserWindow } = require('electron');
  const assert = require('node:assert/strict');
  const bundle = path.join(temporary, 'chat-scroll.js');
  await require('esbuild').build({
    entryPoints: [path.resolve(__dirname, '../src/renderer/ui/components/ChatView.js')],
    bundle: true, outfile: bundle, platform: 'browser', format: 'iife',
    globalName: 'SmokeChat', external: ['electron'], logLevel: 'silent'
  });
  const html = path.join(temporary, 'chat-scroll.html');
  fs.writeFileSync(html, `<link rel="stylesheet" href="${pathToFileURL(path.resolve(__dirname, '../dist/styles.bundle.css')).href}"><style>#restore{display:none;height:600px}.chat-view{height:600px}</style><div id="restore"></div>`);
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const js = code => win.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(condition, message) {
    const deadline = Date.now() + 5000;
    while (!(await js(condition))) { if (Date.now() > deadline) throw new Error(message); await wait(30); }
  }
  try {
    await win.loadFile(html);
    await js(`window.electron_nodeModules = {
      path: { join: (...parts) => parts.join('/'), dirname: p => p.split('/').slice(0, -1).join('/'), basename: p => p.split('/').pop(), extname: () => '', sep: '/' },
      fs: { existsSync: () => false, readFileSync: () => '', writeFileSync() {}, mkdirSync() {}, promises: { readFile: async () => '' } },
      os: { homedir: () => '/fixture' }, process: { resourcesPath: '/fixture' }, __dirname: '/fixture'
    };
    window.historyReads = 0;
    const history = Array.from({length: 80}, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', type: 'text', uuid: 'fixture-' + i, text: 'Previous message ' + i + '\\n\\n' + 'A line of history. '.repeat(20) }));
    window.electron_api = new Proxy({}, { get: (_t, namespace) => new Proxy({}, { get: (_n, method) => (...args) => {
      if (String(method).startsWith('on')) return () => {};
      if (namespace === 'chat' && method === 'loadHistory') { window.historyReads++; return Promise.resolve({success:true, messages:history, truncated:true, total:300}); }
      return Promise.resolve({success:true, messages:[]});
    } }) }); void 0;`);
    await js(fs.readFileSync(bundle, 'utf8') + ';void 0;');
    await js(`window.view = SmokeChat.createChatView(document.getElementById('restore'), {id:'fixture', name:'Fixture', path:'/fixture'}, {resumeSessionId:'old'});
      window.messages = document.querySelector('.chat-messages');
      window.atBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 2; void 0;`);
    await until(`!!document.querySelector('.chat-history-divider')`, 'History did not finish rendering');
    assert.equal(await js('window.historyReads'), 1);
    await js(`document.getElementById('restore').style.display = 'block'; view.focus();`);
    await until('messages.clientHeight > 0 && messages.scrollHeight > messages.clientHeight && atBottom()', 'Hidden restore did not land at the bottom');
    assert.equal(await js('window.historyReads'), 1);
    // Late media layout has the same geometry effect as a diagram/image load.
    await js(`window.late = document.createElement('div'); late.style.height = '100px'; late.style.flexShrink = '0'; messages.appendChild(late);`);
    await wait(60);
    await js(`late.style.height = '650px'`);
    await until('atBottom()', 'Late content growth lost the tail');
    await js(`messages.dispatchEvent(new WheelEvent('wheel', {deltaY:-200})); messages.scrollTop -= 300;`);
    await wait(60);
    const readingPosition = await js('messages.scrollTop');
    await js(`late.style.height = '900px'; view.focus();`);
    await wait(150);
    assert.equal(await js('messages.scrollTop'), readingPosition, 'Layout or focus pulled the reader down');
    await js(`document.querySelector('.chat-scroll-to-bottom').click()`);
    await until('atBottom()', 'Return-to-bottom button did not reach the tail');
    await js('view.destroy()');
    console.log('PASS restored chat: hidden tab, late layout, user scroll and return to tail');
  } finally { win.destroy(); }
};
