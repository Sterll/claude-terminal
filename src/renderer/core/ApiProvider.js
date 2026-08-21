/**
 * ApiProvider — Abstraction over the Electron IPC bridge.
 *
 * In Electron: delegates to window.electron_api / window.electron_nodeModules.
 * In tests: accepts mock objects via constructor.
 * In a future cloud build: could use HTTP/WebSocket instead.
 */
class ApiProvider {
  constructor(electronApi, nodeModules) {
    this._api = electronApi || window.electron_api;
    this._node = nodeModules || window.electron_nodeModules;
  }

  // ── IPC namespace accessors ──

  get terminal() { return this._api.terminal; }
  get git() { return this._api.git; }
  get github() { return this._api.github; }
  get chat() { return this._api.chat; }
  get dialog() { return this._api.dialog; }
  get mcp() { return this._api.mcp; }
  get mcpRegistry() { return this._api.mcpRegistry; }
  get marketplace() { return this._api.marketplace; }
  get plugins() { return this._api.plugins; }
  get usage() { return this._api.usage; }
  get claude() { return this._api.claude; }
  get hooks() { return this._api.hooks; }
  get project() { return this._api.project; }
  get remote() { return this._api.remote; }
  get cloud() { return this._api.cloud; }
  get notification() { return this._api.notification; }
  get updates() { return this._api.updates; }
  get app() { return this._api.app; }
  get window() { return this._api.window; }
  get lifecycle() { return this._api.lifecycle; }
  get setupWizard() { return this._api.setupWizard; }
  get quickPicker() { return this._api.quickPicker; }
  get tray() { return this._api.tray; }
  get fivem() { return this._api.fivem; }
  get webapp() { return this._api.webapp; }
  get api() { return this._api.api; }
  get python() { return this._api.python; }
  get knowledge() { return this._api.knowledge; }

  /** Access any namespace by name */
  get(namespace) {
    return this._api[namespace];
  }

  // ── Node.js module accessors ──

  get fs() { return this._node.fs; }
  get path() { return this._node.path; }
  get os() { return this._node.os; }
  get process() { return this._node.process; }
}

module.exports = { ApiProvider };
