// Dev launcher for `npm run start:sandbox`: points Electron's userData at a
// throwaway directory so a test instance keeps its own localStorage, cache and
// window state instead of sharing the primary instance's. Project and session
// data live in ~/.claude-terminal and ~/.claude, so those are still shared —
// this isolates the Electron profile, not the app's own data.
const { app } = require('electron');
const os = require('os');
const path = require('path');
app.setPath('userData', path.join(os.tmpdir(), 'claude-terminal-dev-userdata'));
require('./main.js');
