# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm install              # Install dependencies
npm start                # Build renderer + run app
npm start -- --dev       # Run with DevTools enabled
npm run watch            # Build renderer in watch mode
npm run build:renderer   # Build renderer only (esbuild)
npm run build            # Build Windows installer (NSIS)
npm run publish          # Build and publish to GitHub releases
```

Renderer is bundled with esbuild (`scripts/build-renderer.js`) into `dist/`.

## Architecture Overview

Claude Terminal is an Electron application for managing Claude Code projects with an integrated terminal environment. Windows-only (10/11).

### Main Process (`src/main/`)

```
src/main/
├── index.js                    # Bootstrap, lifecycle, single-instance lock
├── preload.js                  # Preload script for renderer context
├── ipc/                        # IPC handlers
│   ├── terminal.ipc.js         # Terminal create/input/resize/kill
│   ├── git.ipc.js              # 18+ git handlers (status, branches, merge, clone, etc.)
│   ├── github.ipc.js           # GitHub OAuth Device Flow authentication
│   ├── claude.ipc.js           # Claude Code sessions management
│   ├── usage.ipc.js            # Claude usage tracking (start/stop monitor, refresh)
│   ├── mcp.ipc.js              # MCP server start/stop
│   ├── mcpRegistry.ipc.js      # MCP registry browsing
│   ├── plugin.ipc.js           # Plugin install & marketplace management
│   ├── marketplace.ipc.js      # Skill marketplace install/uninstall
│   ├── fivem.ipc.js            # FiveM server + resource scanning
│   ├── project.ipc.js          # Project operations (TODO scanning, stats)
│   └── dialog.ipc.js           # File dialogs, window controls, notifications, updates
├── services/
│   ├── TerminalService.js      # node-pty terminal management
│   ├── PluginService.js        # Plugin install via Claude CLI PTY
│   ├── MarketplaceService.js   # Skill marketplace management
│   ├── McpService.js           # MCP server process spawning
│   ├── McpRegistryService.js   # MCP registry API client
│   ├── FivemService.js         # FiveM server launcher
│   ├── UpdaterService.js       # electron-updater auto-updates
│   ├── GitHubAuthService.js    # OAuth Device Flow + keytar credential storage
│   └── UsageService.js         # Claude usage via PTY /usage command
├── windows/
│   ├── MainWindow.js
│   ├── QuickPickerWindow.js
│   ├── SetupWizardWindow.js
│   └── TrayManager.js
└── utils/
    ├── paths.js                # Path definitions & helpers
    ├── git.js                  # Git operations helper
    └── commitMessageGenerator.js  # AI commit messages via claude -p CLI
```

### Renderer Process (`src/renderer/`)

```
src/renderer/
├── index.js                    # Module exports
├── services/
│   ├── ProjectService.js       # Project CRUD & folder operations
│   ├── TerminalService.js      # Terminal IPC wrapper
│   ├── SettingsService.js      # Settings management
│   ├── McpService.js           # MCP IPC wrapper
│   ├── FivemService.js         # FiveM IPC wrapper
│   ├── SkillService.js         # Skills loading from ~/.claude/skills + plugins
│   ├── AgentService.js         # Agents loading from ~/.claude/agents
│   ├── DashboardService.js     # Dashboard data with 30s TTL cache
│   └── TimeTrackingDashboard.js # Time tracking charts & stats
├── state/
│   ├── State.js                # Base observable class: state.subscribe(listener)
│   ├── projects.state.js       # Projects & folders
│   ├── terminals.state.js      # Terminal instances
│   ├── mcp.state.js            # MCP servers
│   ├── fivem.state.js          # FiveM servers
│   ├── settings.state.js       # User settings
│   └── timeTracking.state.js   # Time tracking with idle detection (15min timeout)
├── ui/
│   ├── components/
│   │   ├── ProjectList.js      # Project list with folders
│   │   ├── TerminalManager.js  # xterm.js terminal renderer
│   │   ├── Modal.js            # Modal dialogs
│   │   ├── Toast.js            # Toast notifications
│   │   ├── ContextMenu.js      # Right-click context menus
│   │   ├── Tab.js              # Tab management
│   │   ├── CustomizePicker.js  # Theme customization UI
│   │   ├── QuickActions.js     # Per-project quick action buttons
│   │   └── FileExplorer.js     # Integrated file tree browser
│   └── themes/
│       └── terminal-themes.js  # Terminal color themes (Claude, Matrix, Dracula, etc.)
├── features/
│   ├── QuickPicker.js          # Quick project picker
│   ├── KeyboardShortcuts.js    # Keyboard shortcuts (app-scoped, not global)
│   └── DragDrop.js             # Drag & drop for projects
├── i18n/                       # Internationalization
│   ├── index.js                # i18n system with auto-detection
│   └── locales/
│       ├── en.json
│       └── fr.json
└── utils/
    ├── dom.js                  # DOM helpers
    ├── color.js                # Color utilities
    ├── format.js               # Duration & date formatters
    ├── paths.js                # Path utilities
    ├── fileIcons.js            # File type icon mapping
    └── syntaxHighlight.js      # Code syntax highlighting
```

### IPC Communication

**Terminal**: `terminal-create` (handle), `terminal-input/resize/kill` (send), `terminal-data/exit` (receive)

**Git**: `git-info`, `git-info-full`, `git-status-quick`, `git-status-detailed`, `git-branches`, `git-current-branch`, `git-checkout`, `git-create-branch`, `git-delete-branch`, `git-pull`, `git-push`, `git-merge`, `git-merge-abort`, `git-merge-continue`, `git-merge-conflicts`, `git-clone`, `git-stage-files`, `git-commit`, `git-generate-commit-message`, `project-stats`

**GitHub**: `github-start-auth`, `github-poll-token`, `github-auth-status`, `github-logout`, `github-set-token`, `github-get-token`, `github-workflow-runs`, `github-pull-requests`, `github-create-pr`

**Claude**: `claude-sessions`, `get-usage-data`, `refresh-usage`, `start-usage-monitor`, `stop-usage-monitor`

**MCP**: `mcp-start/stop` (invoke), `mcp-output/exit` (receive)

**MCP Registry**: `mcp-registry-browse`, `mcp-registry-search`, `mcp-registry-detail`

**Plugins**: `plugin-installed`, `plugin-catalog`, `plugin-marketplaces`, `plugin-readme`, `plugin-install`, `plugin-add-marketplace`

**Marketplace**: `marketplace-search`, `marketplace-featured`, `marketplace-readme`, `marketplace-install`, `marketplace-uninstall`, `marketplace-installed`

**FiveM**: `fivem-scan-resources`, `fivem-resource-command`

**Dialogs/Window**: `select-folder/file`, `open-in-explorer`, `open-in-editor`, `show-notification`, `window-minimize/maximize/close`, `app-quit`, `set-window-title`, `get-app-version`, `update-install`, `get-launch-at-startup`, `set-launch-at-startup`

**Project**: `scan-todos`, `project-stats`

### Data Storage

```
~/.claude-terminal/
├── projects.json       # Projects with folder hierarchy & time tracking
└── settings.json       # User preferences (accent color, language)

~/.claude/
├── settings.json       # Claude Code settings
├── .claude.json        # Main Claude config with MCP servers
├── skills/             # Custom skills directory
├── agents/             # Custom agents directory
├── projects/           # Claude sessions per project
│   └── {encoded-path}/sessions-index.json
└── plugins/
    └── installed_plugins.json
```

GitHub tokens are stored in Windows Credential Manager via `keytar`.

## Key Implementation Details

- **No context isolation**: `contextIsolation: false` allows direct Node.js access in renderer
- **Single instance**: Uses `app.requestSingleInstanceLock()` - second launch shows existing window
- **Tray integration**: Window minimizes to tray instead of closing
- **Terminal**: xterm.js (with WebGL addon) in renderer, node-pty in main process
- **Windows-specific**: PowerShell default shell, taskkill for process termination, winpty for PTY
- **Renderer bundling**: esbuild bundles `renderer.js` into `dist/`
- **i18n**: Multi-language support (EN/FR) with auto-detection and fallback chain
- **Time tracking**: Automatic per-project tracking with 15min idle timeout and midnight rollover
- **Skills/Agents**: Loaded from `~/.claude/skills`, `~/.claude/agents`, and installed plugins
- **AI commit messages**: Uses `claude -p` CLI for conventional commit message generation
- **GitHub auth**: OAuth Device Flow for secure authentication
- **Usage monitoring**: Spawns PTY to run `/usage` command periodically

## Keyboard Shortcuts

Shortcuts are handled in the renderer (app-scoped, not global):
- `Ctrl+Shift+P`: Quick project picker
- `Ctrl+Shift+T`: New terminal in current project

## Project Structure (Root)

```
├── main.js                        # Bootstrap entry
├── index.html                     # Main window HTML
├── quick-picker.html              # Quick picker window HTML
├── styles.css                     # Global styles
├── renderer.js                    # Renderer entry (bundled to dist/)
├── electron-builder.config.js     # Build configuration
├── scripts/build-renderer.js      # esbuild bundler script
├── resources/bundled-skills/      # Bundled skills (create-skill, create-agents)
└── .github/                       # Issue templates & PR template
```
