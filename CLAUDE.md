# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Terminal is a cross-platform Electron desktop application (v0.9.6) for managing Claude Code projects with an integrated terminal, chat UI, git management, and plugin ecosystem. Primary target: Windows 10/11 with NSIS installer. Also builds for macOS (DMG) and Linux (AppImage).

**Repository:** `github.com/Sterll/claude-terminal` | **License:** GPL-3.0 | **Author:** Yanis

## Build & Development Commands

```bash
npm install              # Install dependencies (Node >=18 required, runs electron-rebuild)
npm start                # Build renderer + run app
npm start -- --dev       # Run with DevTools enabled (start:dev script)
npm run watch            # Build renderer in watch mode (esbuild)
npm run build:renderer   # Build renderer only → dist/renderer.bundle.js
npm run build            # Build installer (NSIS/DMG/AppImage) → build/
npm run build:win        # Build Windows installer only
npm run build:mac        # Build macOS DMG only
npm run build:linux      # Build Linux AppImage only
npm run publish          # Build and publish installer to update server
npm test                 # Run Jest tests (jsdom environment)
npm run test:watch       # Jest in watch mode
```

**Important:** Always run `npm run build:renderer` after modifying any file in `src/renderer/`, `src/project-types/`, or `renderer.js`.

## Architecture Overview

```
Electron Main Process (Node.js)
├── main.js                          # Bootstrap, lifecycle, single-instance lock, global shortcuts
├── src/main/preload.js              # IPC bridge (26 namespaces, 118+ methods as electron_api)
├── src/main/ipc/                    # IPC handlers (16 files, 118 handlers)
├── src/main/services/               # Business logic (13 services)
├── src/main/windows/                # Window managers (5 windows)
└── src/main/utils/                  # Git operations, paths, AI commit, shell

Electron Renderer Process (Browser)
├── renderer.js                      # Entry point & orchestrator (bundled by esbuild → dist/)
├── src/renderer/index.js            # Module loader & initialization
├── src/renderer/state/              # Observable state management (9 modules)
├── src/renderer/services/           # IPC wrappers & business logic (13 services)
├── src/renderer/ui/components/      # UI components (12 components)
├── src/renderer/ui/panels/          # UI panels (10 panels)
├── src/renderer/features/           # Keyboard shortcuts, quick picker, drag-drop
├── src/renderer/events/             # Claude event bus + hook/scraping providers
├── src/renderer/i18n/               # EN/FR internationalization (~800 keys each)
└── src/renderer/utils/              # DOM, color, format, paths, icons, syntax highlighting

Project Types (Plugin System)
└── src/project-types/               # api, fivem, minecraft, python, webapp, general (61 files)

Styles
└── styles/                          # 14 modular CSS files (23,357 lines total)

Remote UI
└── remote-ui/                       # Web interface for remote control (PWA)
```

## Main Process (`src/main/`)

### IPC Handlers (`src/main/ipc/`)

| File | Handlers | Key Operations |
|------|----------|----------------|
| `terminal.ipc.js` | 4 | Create PTY (node-pty), input, resize, kill |
| `git.ipc.js` | 38 | Status, branches, pull/push, merge, clone, stash, cherry-pick, revert, worktrees (11 ops), AI commit message, file diff |
| `github.ipc.js` | 10 | OAuth Device Flow auth, workflow runs, PRs, create PR, token management |
| `chat.ipc.js` | 11 | Agent SDK streaming sessions, permissions, interrupt, model/effort switching, tab name generation, skill/agent generation |
| `dialog.ipc.js` | 18 | Window controls, file/folder dialogs, open in explorer/editor/browser, notifications, updates, startup settings, clipboard |
| `mcp.ipc.js` | 2 | Start/stop MCP server processes |
| `mcpRegistry.ipc.js` | 3 | Browse/search/detail MCP registry (`registry.modelcontextprotocol.io`) |
| `marketplace.ipc.js` | 6 | Search skills, featured, readme, install/uninstall from `skills.sh` |
| `plugin.ipc.js` | 6 | Installed plugins, catalog, marketplaces, readme, install via Claude CLI PTY |
| `usage.ipc.js` | 4 | Claude usage data (OAuth API primary, PTY `/usage` fallback), monitor start/stop |
| `claude.ipc.js` | 2 | Session listing, conversation history (parses .jsonl session files) |
| `project.ipc.js` | 1 | TODO/FIXME/HACK/XXX scanning, project stats |
| `hooks.ipc.js` | 4 | Install/remove/status/verify hooks in `~/.claude/settings.json` |
| `remote.ipc.js` | 9 | Get/generate PIN, server info/start/stop, notify projects/session/tab/time |
| `fivem.ipc.js` | - | Delegated to `src/project-types/fivem/` |
| `index.js` | - | Orchestrator - registers all handlers |

**Total: 118 IPC handlers**

### Services (`src/main/services/`)

| Service | Purpose | Key Detail |
|---------|---------|------------|
| `TerminalService.js` | node-pty management | PowerShell default, adaptive output batching (4ms/16ms/32ms), Claude CLI launch with `--resume` |
| `ChatService.js` | Claude Agent SDK bridge | Streaming input mode, `maxTurns: 100`, permission forwarding, persistent haiku naming session |
| `GitHubAuthService.js` | GitHub OAuth + API | Device Flow, keytar credential storage, Client ID: `Ov23liYfl42qwDVVk99l` |
| `UsageService.js` | Claude usage tracking | OAuth API (`api.anthropic.com/api/oauth/usage`), PTY fallback, 5min staleness |
| `McpService.js` | MCP server processes | Child process spawning with env vars, force-kill via taskkill |
| `MarketplaceService.js` | Skill marketplace | `skills.sh/api/search`, git clone install, caching (5-30min TTL) |
| `McpRegistryService.js` | MCP server registry | `registry.modelcontextprotocol.io/v0.1`, pagination, caching |
| `PluginService.js` | Claude Code plugins | Read metadata, PTY-based `/plugin install` execution |
| `UpdaterService.js` | Auto-updates | electron-updater, 30min periodic checks, stale cache cleanup |
| `HooksService.js` | Claude hooks management | 15 hook types, non-destructive install, auto-backup/repair |
| `HookEventServer.js` | Hook event receiver | HTTP server on `127.0.0.1:0`, receives POST from hook handler |
| `RemoteServer.js` | WebSocket remote control | WS server on dynamic port, PIN 6-digit auth, broadcast updates to remote-ui |
| `FivemService.js` | FiveM server launcher | Delegated to project-types |

### Windows (`src/main/windows/`)

| Window | Config | Purpose |
|--------|--------|---------|
| `MainWindow.js` | 1400x900, min 1000x600, frameless | Main app, tray minimize, Ctrl+Arrow tab navigation |
| `QuickPickerWindow.js` | 600x400, always-on-top, transparent | Quick project picker (Ctrl+Shift+P) |
| `SetupWizardWindow.js` | 900x650 | 7-step first-launch wizard (language, color, editor, hooks) |
| `TrayManager.js` | System tray | Context menu: Open, Quick Pick, New Terminal, Quit |
| `NotificationWindow.js` | Small overlay | Custom notification with auto-dismiss progress bar |

### Utilities (`src/main/utils/`)

| Utility | Purpose |
|---------|---------|
| `paths.js` | Path constants (`~/.claude-terminal/`, `~/.claude/`), `ensureDataDir()`, `loadAccentColor()` |
| `git.js` | 20+ git operations via `execGit()`, status parsing, safe.directory handling, 15s timeout, worktree support (7 functions) |
| `commitMessageGenerator.js` | AI commit via GitHub Models API (gpt-4o-mini), heuristic fallback |
| `shell.js` | Shell utilities (PATH resolution for macOS/Linux) |

## Renderer Process (`src/renderer/`)

### Initialization Flow (`src/renderer/index.js`)

1. Platform detection (add class `platform-{win32|darwin|linux}` on body)
2. `utils.ensureDirectories()` - Create data dirs
3. `state.initializeState()` - Load all state modules
4. Load i18n with saved language or auto-detect
5. Initialize settings (apply accent color)
6. Register MCP, WebApp, FiveM event listeners
7. Initialize Claude event bus (hooks/scraping providers)
8. Load disk-cached dashboard data
9. Preload all projects (500ms delay)

### State Management (`src/renderer/state/`)

Base class `State.js`: Observable with `subscribe()`, batched notifications via `requestAnimationFrame`.

| Module | State Shape | Key Features |
|--------|-------------|--------------|
| `projects.state.js` | `{ projects[], folders[], rootOrder[], selectedProjectFilter, openedProjectId }` | CRUD, folder nesting, quick actions, color/icon, debounced save (500ms), atomic writes |
| `terminals.state.js` | `{ terminals: Map, activeTerminal, detailTerminal }` | Per-project terminal tracking, stats |
| `settings.state.js` | `{ editor, accentColor, language, defaultTerminalMode, chatModel, pinnedTabs, ... }` | 15+ settings, debounced persistence. `pinnedTabs` controls which sidebar tabs are visible (rest go to More overflow menu). |
| `timeTracking.state.js` | `{ version, month, global, projects }` per session | 15min idle timeout, midnight rollover, 30min session merge, monthly archival |
| `mcp.state.js` | `{ mcps[], mcpProcesses{}, selectedMcp }` | Status tracking, 1000-entry log limit |
| `git.state.js` | `{ gitOperations: Map, gitRepoStatus: Map }` | Pull/push/merge state per project |
| `fivem.state.js` | FiveM resource state | Resource scanning results |

**Additional simple states (in index.js):** `quickPickerState`, `dragState`, `contextMenuState`, `skillsAgentsState`

### Services (`src/renderer/services/`)

| Service | Purpose |
|---------|---------|
| `TerminalService.js` | xterm.js creation (WebGL, 10k scrollback), mount, fit, IPC wrappers |
| `ProjectService.js` | Add/delete/open projects, editor integration, git status check |
| `SettingsService.js` | Accent color DOM application, notification permissions, window title |
| `DashboardService.js` | HTML builders (`buildXxxHtml()`), data caching (30s TTL), disk cache |
| `TimeTrackingDashboard.js` | Time tracking charts & statistics |
| `GitTabService.js` | Git operations UI helpers, status display |
| `McpService.js` | Load/save MCP configs from `~/.claude.json` |
| `SkillService.js` | Load skills from `~/.claude/skills/` with YAML frontmatter |
| `AgentService.js` | Load agents from `~/.claude/agents/` |
| `ArchiveService.js` | Past-month time tracking archival |
| `FivemService.js` | FiveM IPC wrapper |
| `ContextPromptService.js` | Context prompts management for chat |

### UI Components (`src/renderer/ui/components/`)

| Component | Purpose |
|-----------|---------|
| `ProjectList.js` | Hierarchical project/folder tree with drag-drop |
| `TerminalManager.js` | Terminal tabs, xterm rendering, active switching, multi-terminal per project |
| `ChatView.js` | Chat interface for Agent SDK sessions, markdown rendering, permission handling |
| `FileExplorer.js` | Integrated file tree browser with file operations |
| `Modal.js` | Reusable modal (small/medium/large), ESC/overlay close |
| `CustomizePicker.js` | Project customization (color, icon, name) |
| `QuickActions.js` | Per-project quick action configuration |
| `ContextMenu.js` | Right-click menus for projects/folders |
| `Tab.js` | Tab navigation component |
| `Toast.js` | Non-blocking toast notifications |
| `MenuSection.js` | Menu section grouping |

### UI Panels (`src/renderer/ui/panels/`)

| Panel | Purpose |
|-------|---------|
| `SettingsPanel.js` | App settings, accent color, language, editor, startup, hooks config |
| `GitChangesPanel.js` | Git status, staging, unstaging, commit, push/pull, inline diff viewer |
| `McpPanel.js` | MCP server management, start/stop, config |
| `PluginsPanel.js` | Claude Code plugins browse, install, uninstall |
| `SkillsAgentsPanel.js` | Skills and agents display |
| `MarketplacePanel.js` | Skill marketplace search and installation |
| `MemoryEditor.js` | MEMORY.md editor |
| `ShortcutsManager.js` | Keyboard shortcuts configuration |
| `RemotePanel.js` | Remote control interface (PIN display, QR code, server start/stop) |

### Features (`src/renderer/features/`)

| Feature | Shortcuts |
|---------|-----------|
| `KeyboardShortcuts.js` | `Ctrl+T` new terminal, `Ctrl+W` close, `Ctrl+P` quick picker, `Ctrl+,` settings, `Ctrl+Tab`/`Ctrl+Shift+Tab` switch terminals, `Escape` close overlays |
| `QuickPicker.js` | Arrow navigation, Enter select, Escape close, real-time search |
| `DragDrop.js` | HTML5 drag-drop for projects/folders reordering |

**Global shortcuts** (registered in main process): `Ctrl+Shift+P` (quick picker), `Ctrl+Shift+T` (new terminal)

### Events System (`src/renderer/events/`)

| Module | Purpose |
|--------|---------|
| `ClaudeEventBus.js` | Pub-sub for Claude activity (SESSION_START/END, TOOL_START/END, PROMPT_SUBMIT) |
| `HooksProvider.js` | Event detection via Claude hooks (HTTP event server) |
| `ScrapingProvider.js` | Fallback event detection via terminal output parsing |
| `index.js` | Provider selection, wires consumers (time tracking, notifications, dashboard) |

### Internationalization (`src/renderer/i18n/`)

- **Languages:** French (default), English
- **Keys:** ~800 per locale file
- **System:** Dot-notation keys with `{variable}` interpolation
- **Detection:** Auto-detect from `navigator.language`, fallback to `fr`
- **Files:** `locales/en.json`, `locales/fr.json`
- **Usage:** `t('projects.openFolder')`, `t('key', { count: 5 })`
- **HTML:** `data-i18n` attributes for static text

## Project Types (`src/project-types/`)

Pluggable project type system with base class (`base-type.js`) and registry (`registry.js`):

| Type | Features |
|------|----------|
| `api/` | Route detection, API testing, dashboard |
| `fivem/` | FiveM server launcher, resource scanning, console management |
| `minecraft/` | Minecraft server support |
| `python/` | Python environment detection, venv |
| `webapp/` | Web framework detection, dev server |
| `general/` | Default fallback type |

Each type provides: `main/[Type]Service.js`, `main/[type].ipc.js`, `renderer/[Type]Dashboard.js`, `renderer/[Type]ProjectList.js`, `renderer/[Type]RendererService.js`, `renderer/[Type]State.js`, `renderer/[Type]TerminalPanel.js`, `renderer/[Type]Wizard.js`, `i18n/en.json`, `i18n/fr.json`.

## Remote Control System

- **`remote-ui/`** — PWA web interface for remote control from mobile/browser
- **`RemoteServer.js`** — WebSocket server (main process) on dynamic port, PIN 6-digit auth
- **`remote.ipc.js`** — 9 IPC handlers: get/generate PIN, server info/start/stop, notify updates
- **`RemotePanel.js`** — UI panel: PIN display, QR code generation, server status
- **Authentication:** 6-digit PIN, unique per session
- **Transport:** WebSocket (`ws` package v8.19.0)
- **QR code:** Generated via `qrcode` package v1.5.4

## HTML Pages

| File | Lines | Purpose |
|------|-------|---------|
| `index.html` | 772 | Main app: titlebar (usage, time, controls), sidebar (11+ tabs), content panels, modals |
| `quick-picker.html` | 286 | Standalone quick picker with inline Node.js script |
| `setup-wizard.html` | 1476 | 7-step onboarding wizard with embedded EN/FR translations |
| `notification.html` | 207 | Custom notification with auto-dismiss progress bar |

## CSS Architecture (`styles/` - 14 files, 23,357 lines)

### CSS Variables (`:root` in `base.css`)

```css
/* Colors */
--bg-primary: #0d0d0d;  --bg-secondary: #151515;  --bg-tertiary: #1a1a1a;
--bg-hover: #252525;     --bg-active: #2a2a2a;     --border-color: #2d2d2d;
--text-primary: #e0e0e0; --text-secondary: #888;    --text-muted: #555;
--accent: #d97706;       --accent-hover: #f59e0b;   --accent-dim: rgba(217,119,6,0.15);
--success: #22c55e;      --warning: #f59e0b;        --danger: #ef4444;  --info: #3b82f6;

/* Layout */
--radius: 8px;  --radius-sm: 4px;  --sidebar-width: 200px;  --projects-panel-width: 350px;

/* Typography (rem-based) */
--font-2xs: 0.625rem;  --font-xs: 0.6875rem;  --font-sm: 0.8125rem;
--font-base: 0.875rem;  --font-md: 1rem;  --font-lg: 1.125rem;
```

### CSS Files

| File | Lines | Section |
|------|-------|---------|
| `base.css` | 244 | Variables, fonts, reset |
| `layout.css` | 885 | Sidebar, content grid |
| `terminal.css` | 1528 | xterm, tabs, loading |
| `projects.css` | 3468 | Project list, tree, drag-drop |
| `chat.css` | 2990 | Chat UI, messages, markdown |
| `git.css` | 2871 | Git panel, diff view, worktrees |
| `dashboard.css` | 2065 | Stats cards, sections |
| `settings.css` | 1896 | Settings forms |
| `modals.css` | 1752 | Modal dialogs |
| `time-tracking.css` | 1118 | Charts, stats |
| `skills.css` | 1254 | Skills/agents panel |
| `mcp.css` | 562 | MCP management |
| `memory.css` | 668 | Memory editor |
| `fivem.css` | 2056 | FiveM-specific |

### Naming Convention

```css
.component-name { }           /* Base styles */
.component-name.state { }     /* State modifier (e.g., .project-item.active) */
.component-name[data-x] { }   /* Data attribute conditional */
.component-name:has(.child) {} /* Parent selector */
```

## Preload Bridge (`src/main/preload.js`)

Exposes 26 API namespaces to renderer via `window.electron_api`:

`terminal` | `git` (38 methods) | `github` | `chat` | `mcp` | `mcpRegistry` | `marketplace` | `plugins` | `dialog` | `window` | `app` | `notification` | `usage` | `project` | `claude` | `hooks` | `updates` | `setupWizard` | `lifecycle` | `quickPicker` | `tray` | `fivem` | `webapp` | `api` | `python` | `remote`

Also exposes `window.electron_nodeModules`: `path`, `fs` (sync + promises), `os.homedir()`, `process.env`, `child_process.execSync`

## Data Storage

```
~/.claude-terminal/                    # App data directory
├── projects.json                      # Projects with folder hierarchy & quick actions
├── settings.json                      # User preferences (accent color, language, editor, etc.)
├── timetracking.json                  # Time tracking data (v2 format)
├── marketplace.json                   # Installed skills manifest
├── hooks/port                         # Hook event server port file
└── archives/YYYY/MM/archive-data.json # Archived time tracking sessions

~/.claude/                             # Claude Code directory
├── settings.json                      # Claude Code settings (with hooks definitions)
├── .claude.json                       # MCP server configurations
├── .credentials.json                  # OAuth tokens (accessToken, refreshToken)
├── skills/                            # Installed skills (SKILL.md + files)
├── agents/                            # Custom agents (AGENT.md + files)
├── projects/{encoded-path}/           # Session data per project
│   └── sessions-index.json
└── plugins/
    ├── installed_plugins.json
    └── known_marketplaces.json

Windows Credential Manager (via keytar)  # GitHub token storage
```

## Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `electron` | ^28.0.0 | Desktop framework (Chromium 120) |
| `@anthropic-ai/claude-agent-sdk` | ^0.2.42 | Claude Code streaming chat integration |
| `@xterm/xterm` | ^6.0.0 | Terminal emulator |
| `@xterm/addon-webgl` | ^0.19.0 | WebGL-accelerated terminal rendering |
| `@xterm/addon-fit` | ^0.11.0 | Auto-fit terminal to container |
| `node-pty` | ^1.1.0 | PTY process management |
| `keytar` | ^7.9.0 | OS credential storage (Windows Credential Manager) |
| `marked` | ^17.0.3 | Markdown to HTML rendering |
| `electron-updater` | ^6.1.7 | Auto-update with generic provider |
| `ws` | ^8.19.0 | WebSocket server for remote control |
| `qrcode` | ^1.5.4 | QR code generation for remote access |
| `esbuild` | ^0.27.2 | Renderer bundling (IIFE, Chrome 120 target, sourcemaps) |
| `jest` | ^29.7.0 | Unit testing (jsdom environment) |
| `playwright` | ^1.58.2 | Browser automation (screenshots, tests) |

## Key Implementation Details

- **No context isolation in preload:** `contextIsolation: false` + `nodeIntegration: false` with full `electron_api` bridge
- **Single instance:** `app.requestSingleInstanceLock()` prevents multiple instances
- **Tray integration:** Close button minimizes to tray, `app-quit` for real exit
- **Frameless window:** Custom titlebar in HTML/CSS with `-webkit-app-region: drag`
- **Terminal:** xterm.js (WebGL addon) in renderer, node-pty (PowerShell) in main, adaptive batching
- **Chat:** Agent SDK streaming input mode with async iterator for multi-turn conversations
- **AI commits:** GitHub Models API (gpt-4o-mini, free tier) with heuristic fallback
- **Hooks:** 15 hook types installed into `~/.claude/settings.json`, HTTP event server for real-time events
- **Time tracking:** 15min idle timeout, 2min output idle, 30min session merge, midnight rollover, monthly archival
- **Renderer bundling:** esbuild IIFE bundle → `dist/renderer.bundle.js` with sourcemaps
- **Persistence:** Atomic writes (temp file + rename), backup files (`.bak`), corruption recovery
- **Updates:** Generic provider, 30min periodic checks, differential packages
- **Remote control:** WebSocket server with PIN auth, QR code for easy mobile connection, PWA in `remote-ui/`
- **Git worktrees:** Full worktree support in git.js (7 functions) and git.ipc.js

## Testing

```bash
npm test                    # Run all tests (14 suites)
npm run test:watch          # Watch mode
```

- **Framework:** Jest with jsdom environment
- **Setup:** `tests/setup.js` mocks `window.electron_nodeModules` and `window.electron_api`
- **Test files:**
  - `tests/state/` - State.test.js, settings.test.js, projects.state.test.js, timeTracking.state.test.js
  - `tests/services/` - ChatService.test.js, RemoteServer.test.js
  - `tests/features/` - KeyboardShortcuts.test.js
  - `tests/utils/` - color.test.js, format.test.js, fileIcons.test.js, git.test.js, shell.test.js
  - `tests/remote-ui/` - hierarchy.test.js
- **Pattern:** `**/tests/**/*.test.js`

## CI/CD

**GitHub Actions:**

- **`ci.yml`:** Triggers on push to `main` and PRs. Matrix: Node 18 + 20 on windows-latest, ubuntu-latest, macos-latest. Steps: checkout, npm ci, build:renderer, test.
- **`release.yml`:** Triggers on `v*` tags. Builds NSIS (Windows x64), DMG (macOS arm64 + x64), AppImage (Linux x64).

**Installer:** electron-builder config in `electron-builder.config.js`. AppId: `com.yanis.claude-terminal`. NSIS per-user install with custom images. Publishes to GitHub releases.

## Bundled Resources

- **`resources/bundled-skills/`:** `create-skill` (skill creation guide), `create-agents` (agent creation guide with templates)
- **`resources/hooks/claude-terminal-hook-handler.js`:** Node.js script called by Claude hooks, forwards events via HTTP POST
- **`assets/`:** `icon.ico`, `icon.png`, `claude-mascot.svg`, `mascot-dance.svg`
- **`website/`:** Landing page, changelog, privacy policy, legal terms, mascot demo, OG generator
- **`remote-ui/`:** PWA web interface for remote control (bundled via extraResources)

## Conventions

- **Commits:** `feat(scope): description` in English, imperative mood
- **IPC pattern:** Service (main) -> IPC handler -> Preload bridge -> Renderer service
- **Dashboard sections:** `buildXxxHtml()` functions in `DashboardService.js`
- **CSS:** `.component-name.state` pattern, CSS variables for theming, 14 modular files in `styles/`
- **i18n:** Add keys to both `en.json` and `fr.json`, use `t('dot.path')` in code. Error messages in main process must be in English (not hardcoded French).
- **State updates:** Use `state.set()` or `state.setProp()`, subscribe with `state.subscribe()`
- **File I/O:** Always use atomic writes for user data (temp + rename)
- **Project types:** Extend `BaseType`, register in `registry.js`, provide service + IPC + dashboard + i18n
