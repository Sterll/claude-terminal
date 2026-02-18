/**
 * Preload Script
 * Exposes IPC API to renderer with context isolation
 */

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

// Expose Node.js modules that are needed in renderer
// Note: For better security, these operations should eventually be moved to main process
contextBridge.exposeInMainWorld('electron_nodeModules', {
  path: {
    join: (...args) => path.join(...args),
    dirname: (p) => path.dirname(p),
    basename: (p, ext) => path.basename(p, ext),
    relative: (from, to) => path.relative(from, to),
    resolve: (...args) => path.resolve(...args),
    sep: path.sep
  },
  fs: {
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p, options) => fs.readFileSync(p, options),
    writeFileSync: (p, data, options) => fs.writeFileSync(p, data, options),
    readdirSync: (p, options) => fs.readdirSync(p, options),
    statSync: (p) => {
      const stat = fs.statSync(p);
      return {
        isDirectory: () => stat.isDirectory(),
        isFile: () => stat.isFile(),
        size: stat.size,
        mtime: stat.mtime
      };
    },
    mkdirSync: (p, options) => fs.mkdirSync(p, options),
    rmSync: (p, options) => fs.rmSync(p, options),
    copyFileSync: (src, dest) => fs.copyFileSync(src, dest),
    unlinkSync: (p) => fs.unlinkSync(p),
    renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
    promises: {
      access: (p, mode) => fs.promises.access(p, mode),
      readdir: (p, options) => fs.promises.readdir(p, options),
      readFile: (p, options) => fs.promises.readFile(p, options),
      stat: (p) => fs.promises.stat(p).then(stat => ({
        isDirectory: () => stat.isDirectory(),
        isFile: () => stat.isFile(),
        size: stat.size,
        mtime: stat.mtime
      }))
    }
  },
  os: {
    homedir: () => require('os').homedir()
  },
  process: {
    env: {
      USERPROFILE: process.env.USERPROFILE,
      HOME: process.env.HOME,
      APPDATA: process.env.APPDATA
    },
    resourcesPath: process.resourcesPath || '',
    platform: process.platform
  },
  child_process: {
    execSync: (cmd, options) => require('child_process').execSync(cmd, options)
  },
  // __dirname from preload (src/main) - calculate app root by going up two levels
  __dirname: path.join(__dirname, '..', '..')
});

// Helper to create safe IPC listener that returns unsubscribe function
function createListener(channel) {
  return (callback) => {
    const subscription = (event, ...args) => callback(...args);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  };
}

// Expose protected API to renderer
contextBridge.exposeInMainWorld('electron_api', {
  // ==================== TERMINAL ====================
  terminal: {
    create: (params) => ipcRenderer.invoke('terminal-create', params),
    input: (params) => ipcRenderer.send('terminal-input', params),
    resize: (params) => ipcRenderer.send('terminal-resize', params),
    kill: (params) => ipcRenderer.send('terminal-kill', params),
    onData: createListener('terminal-data'),
    onExit: createListener('terminal-exit')
  },

  // ==================== GIT ====================
  git: {
    info: (projectPath) => ipcRenderer.invoke('git-info', projectPath),
    infoFull: (projectPath) => ipcRenderer.invoke('git-info-full', projectPath),
    statusQuick: (params) => ipcRenderer.invoke('git-status-quick', params),
    statusDetailed: (params) => ipcRenderer.invoke('git-status-detailed', params),
    branches: (params) => ipcRenderer.invoke('git-branches', params),
    currentBranch: (params) => ipcRenderer.invoke('git-current-branch', params),
    mergeInProgress: (params) => ipcRenderer.invoke('git-merge-in-progress', params),
    mergeConflicts: (params) => ipcRenderer.invoke('git-merge-conflicts', params),
    pull: (params) => ipcRenderer.invoke('git-pull', params),
    push: (params) => ipcRenderer.invoke('git-push', params),
    checkout: (params) => ipcRenderer.invoke('git-checkout', params),
    merge: (params) => ipcRenderer.invoke('git-merge', params),
    mergeAbort: (params) => ipcRenderer.invoke('git-merge-abort', params),
    mergeContinue: (params) => ipcRenderer.invoke('git-merge-continue', params),
    clone: (params) => ipcRenderer.invoke('git-clone', params),
    stageFiles: (params) => ipcRenderer.invoke('git-stage-files', params),
    commit: (params) => ipcRenderer.invoke('git-commit', params),
    generateCommitMessage: (params) => ipcRenderer.invoke('git-generate-commit-message', params),
    createBranch: (params) => ipcRenderer.invoke('git-create-branch', params),
    deleteBranch: (params) => ipcRenderer.invoke('git-delete-branch', params),
    commitHistory: (params) => ipcRenderer.invoke('git-commit-history', params),
    fileDiff: (params) => ipcRenderer.invoke('git-file-diff', params),
    commitDetail: (params) => ipcRenderer.invoke('git-commit-detail', params),
    cherryPick: (params) => ipcRenderer.invoke('git-cherry-pick', params),
    revert: (params) => ipcRenderer.invoke('git-revert', params),
    unstageFiles: (params) => ipcRenderer.invoke('git-unstage-files', params),
    stashApply: (params) => ipcRenderer.invoke('git-stash-apply', params),
    stashDrop: (params) => ipcRenderer.invoke('git-stash-drop', params),
    stashSave: (params) => ipcRenderer.invoke('git-stash-save', params),
    // Worktrees
    worktreeList: (params) => ipcRenderer.invoke('git-worktree-list', params),
    worktreeCreate: (params) => ipcRenderer.invoke('git-worktree-create', params),
    worktreeRemove: (params) => ipcRenderer.invoke('git-worktree-remove', params),
    worktreeLock: (params) => ipcRenderer.invoke('git-worktree-lock', params),
    worktreeUnlock: (params) => ipcRenderer.invoke('git-worktree-unlock', params),
    worktreePrune: (params) => ipcRenderer.invoke('git-worktree-prune', params),
    worktreeDetect: (params) => ipcRenderer.invoke('git-worktree-detect', params),
    worktreeDiff: (params) => ipcRenderer.invoke('git-worktree-diff', params)
  },

  // ==================== WEBAPP ====================
  webapp: {
    start: (params) => ipcRenderer.invoke('webapp-start', params),
    stop: (params) => ipcRenderer.invoke('webapp-stop', params),
    input: (params) => ipcRenderer.send('webapp-input', params),
    resize: (params) => ipcRenderer.send('webapp-resize', params),
    detectFramework: (params) => ipcRenderer.invoke('webapp-detect-framework', params),
    getPort: (params) => ipcRenderer.invoke('webapp-get-port', params),
    onData: createListener('webapp-data'),
    onExit: createListener('webapp-exit'),
    onPortDetected: createListener('webapp-port-detected')
  },

  // ==================== FIVEM ====================
  fivem: {
    start: (params) => ipcRenderer.invoke('fivem-start', params),
    stop: (params) => ipcRenderer.invoke('fivem-stop', params),
    input: (params) => ipcRenderer.send('fivem-input', params),
    resize: (params) => ipcRenderer.send('fivem-resize', params),
    scanResources: (params) => ipcRenderer.invoke('fivem-scan-resources', params),
    resourceCommand: (params) => ipcRenderer.invoke('fivem-resource-command', params),
    onData: createListener('fivem-data'),
    onExit: createListener('fivem-exit')
  },

  // ==================== PYTHON ====================
  python: {
    detectInfo: (params) => ipcRenderer.invoke('python-detect-info', params)
  },

  // ==================== API ====================
  api: {
    start: (params) => ipcRenderer.invoke('api-start', params),
    stop: (params) => ipcRenderer.invoke('api-stop', params),
    input: (params) => ipcRenderer.send('api-input', params),
    resize: (params) => ipcRenderer.send('api-resize', params),
    detectFramework: (params) => ipcRenderer.invoke('api-detect-framework', params),
    getPort: (params) => ipcRenderer.invoke('api-get-port', params),
    detectRoutes: (params) => ipcRenderer.invoke('api-detect-routes', params),
    testRequest: (params) => ipcRenderer.invoke('api-test-request', params),
    onData: createListener('api-data'),
    onExit: createListener('api-exit'),
    onPortDetected: createListener('api-port-detected')
  },

  // ==================== MCP ====================
  mcp: {
    start: (params) => ipcRenderer.invoke('mcp-start', params),
    stop: (params) => ipcRenderer.invoke('mcp-stop', params),
    onOutput: createListener('mcp-output'),
    onExit: createListener('mcp-exit')
  },

  // ==================== DIALOG & SYSTEM ====================
  dialog: {
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    selectFile: (params) => ipcRenderer.invoke('select-file', params),
    openInExplorer: (path) => ipcRenderer.send('open-in-explorer', path),
    openInEditor: (params) => ipcRenderer.send('open-in-editor', params),
    openExternal: (url) => ipcRenderer.send('open-external', url)
  },

  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    setTitle: (title) => ipcRenderer.send('set-window-title', title),
    onCtrlArrow: createListener('ctrl-arrow')
  },

  app: {
    quit: () => ipcRenderer.send('app-quit'),
    getVersion: () => ipcRenderer.invoke('get-app-version'),
    getLaunchAtStartup: () => ipcRenderer.invoke('get-launch-at-startup'),
    setLaunchAtStartup: (enabled) => ipcRenderer.invoke('set-launch-at-startup', enabled),
    installUpdate: () => ipcRenderer.send('update-install')
  },

  // ==================== NOTIFICATIONS ====================
  notification: {
    show: (params) => ipcRenderer.send('show-notification', params),
    onClicked: createListener('notification-clicked')
  },

  // ==================== GITHUB ====================
  github: {
    startAuth: () => ipcRenderer.invoke('github-start-auth'),
    openAuthUrl: (url) => ipcRenderer.invoke('github-open-auth-url', url),
    pollToken: (params) => ipcRenderer.invoke('github-poll-token', params),
    authStatus: () => ipcRenderer.invoke('github-auth-status'),
    logout: () => ipcRenderer.invoke('github-logout'),
    setToken: (token) => ipcRenderer.invoke('github-set-token', token),
    getToken: () => ipcRenderer.invoke('github-get-token'),
    workflowRuns: (remoteUrl) => ipcRenderer.invoke('github-workflow-runs', { remoteUrl }),
    pullRequests: (remoteUrl) => ipcRenderer.invoke('github-pull-requests', { remoteUrl }),
    createPR: (params) => ipcRenderer.invoke('github-create-pr', params)
  },

  // ==================== MCP REGISTRY ====================
  mcpRegistry: {
    browse: (limit, cursor) => ipcRenderer.invoke('mcp-registry-browse', { limit, cursor }),
    search: (query, limit) => ipcRenderer.invoke('mcp-registry-search', { query, limit }),
    detail: (name) => ipcRenderer.invoke('mcp-registry-detail', { name }),
  },

  // ==================== PLUGINS ====================
  plugins: {
    installed: () => ipcRenderer.invoke('plugin-installed'),
    catalog: () => ipcRenderer.invoke('plugin-catalog'),
    marketplaces: () => ipcRenderer.invoke('plugin-marketplaces'),
    readme: (marketplace, pluginName) => ipcRenderer.invoke('plugin-readme', { marketplace, pluginName }),
    install: (marketplace, pluginName) => ipcRenderer.invoke('plugin-install', { marketplace, pluginName }),
    addMarketplace: (url) => ipcRenderer.invoke('plugin-add-marketplace', { url })
  },

  // ==================== MARKETPLACE ====================
  marketplace: {
    search: (query, limit) => ipcRenderer.invoke('marketplace-search', { query, limit }),
    featured: (limit) => ipcRenderer.invoke('marketplace-featured', { limit }),
    readme: (source, skillId) => ipcRenderer.invoke('marketplace-readme', { source, skillId }),
    install: (skill) => ipcRenderer.invoke('marketplace-install', { skill }),
    uninstall: (skillId) => ipcRenderer.invoke('marketplace-uninstall', { skillId }),
    installed: () => ipcRenderer.invoke('marketplace-installed')
  },

  // ==================== PROJECT ====================
  project: {
    scanTodos: (projectPath) => ipcRenderer.invoke('scan-todos', projectPath),
    stats: (projectPath) => ipcRenderer.invoke('project-stats', projectPath)
  },

  // ==================== CLAUDE ====================
  claude: {
    sessions: (projectPath) => ipcRenderer.invoke('claude-sessions', projectPath)
  },

  // ==================== CHAT (Agent SDK) ====================
  chat: {
    start: (params) => ipcRenderer.invoke('chat-start', params),
    send: (params) => ipcRenderer.invoke('chat-send', params),
    close: (params) => ipcRenderer.send('chat-close', params),
    interrupt: (params) => ipcRenderer.send('chat-interrupt', params),
    respondPermission: (params) => ipcRenderer.send('chat-permission-response', params),
    alwaysAllow: (params) => ipcRenderer.send('chat-always-allow', params),
    onMessage: createListener('chat-message'),
    onError: createListener('chat-error'),
    onDone: createListener('chat-done'),
    onIdle: createListener('chat-idle'),
    onPermissionRequest: createListener('chat-permission-request'),
    generateTabName: (params) => ipcRenderer.invoke('chat-generate-tab-name', params),
    loadHistory: (params) => ipcRenderer.invoke('chat-load-history', params),
    generateSkillAgent: (params) => ipcRenderer.invoke('chat-generate-skill-agent', params),
    cancelGeneration: (params) => ipcRenderer.send('chat-cancel-generation', params)
  },

  // ==================== HOOKS ====================
  hooks: {
    install: () => ipcRenderer.invoke('hooks-install'),
    remove: () => ipcRenderer.invoke('hooks-remove'),
    status: () => ipcRenderer.invoke('hooks-status'),
    verify: () => ipcRenderer.invoke('hooks-verify'),
    onEvent: createListener('hook-event')
  },

  // ==================== USAGE ====================
  usage: {
    getData: () => ipcRenderer.invoke('get-usage-data'),
    refresh: () => ipcRenderer.invoke('refresh-usage'),
    startMonitor: (intervalMs) => ipcRenderer.invoke('start-usage-monitor', intervalMs),
    stopMonitor: () => ipcRenderer.invoke('stop-usage-monitor')
  },

  // ==================== QUICK PICKER ====================
  quickPicker: {
    select: (project) => ipcRenderer.send('quick-pick-select', project),
    close: () => ipcRenderer.send('quick-pick-close'),
    onReloadProjects: createListener('reload-projects'),
    onOpenProject: createListener('open-project')
  },

  // ==================== TRAY ====================
  tray: {
    updateAccentColor: (color) => ipcRenderer.send('update-accent-color', color),
    onOpenTerminal: createListener('open-terminal-current-project'),
    onShowSessions: createListener('show-sessions-panel')
  },

  // ==================== UPDATES ====================
  updates: {
    onStatus: createListener('update-status'),
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates')
  },

  // ==================== SETUP WIZARD ====================
  setupWizard: {
    complete: (settings) => ipcRenderer.invoke('setup-wizard-complete', settings),
    skip: () => ipcRenderer.send('setup-wizard-skip')
  },

  // ==================== APP LIFECYCLE ====================
  lifecycle: {
    onWillQuit: createListener('app-will-quit')
  }
});
