# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Terminal is a cross-platform Electron desktop application (**v1.2.6**) for managing Claude Code projects. It bundles an integrated terminal, a Claude Agent SDK chat UI, full Git workflow, a visual workflow automation editor (LiteGraph), parallel task orchestration, a Control Tower for multi-agent supervision, a workspace knowledge base, cloud sync, a PWA remote control, and a plugin/skill ecosystem. Primary target: Windows 10/11 with NSIS installer. Also builds for macOS (DMG) and Linux (AppImage / Snap / Flatpak).

**Repository:** `github.com/Sterll/claude-terminal` | **License:** GPL-3.0 | **Author:** Yanis

## Build & Development Commands

```bash
npm install              # Install dependencies (Node >=18, runs electron-rebuild for node-pty, keytar, better-sqlite3)
npm start                # Build renderer + run app
npm run start:dev        # Run with DevTools enabled
npm run start:inspect    # Run with remote debugging port 9222
npm run watch            # Build renderer in watch mode (esbuild)
npm run build:renderer   # Build renderer only -> dist/renderer.bundle.js
npm run build            # Build installer for current platform -> build/
npm run build:win        # Windows NSIS installer
npm run build:mac        # macOS DMG
npm run build:linux      # Linux AppImage
npm run publish          # Build and publish Windows installer to update server
npm test                 # Run Jest tests (jsdom, 40 test files)
npm run test:watch       # Jest in watch mode
```

**Important:** Always run `npm run build:renderer` after modifying anything under `src/renderer/`, `src/project-types/`, or `renderer.js`.

## Architecture Overview

```
Electron Main Process (Node.js)
├── main.js                          # Bootstrap, lifecycle, single-instance lock, global shortcuts
├── src/main/preload.js              # IPC bridge (window.electron_api)
├── src/main/preload-quickpicker.js  # Preload for Quick Picker window
├── src/main/ipc/                    # 26 IPC files, 256 handlers total
├── src/main/services/               # 24 services
├── src/main/windows/                # 5 window managers
├── src/main/utils/                  # 9 utilities
├── src/main/workflow-nodes/         # 21 workflow node types
└── src/main/workflow-triggers/      # 6 trigger types

Electron Renderer Process (Browser)
├── renderer.js                      # Entry point (bundled by esbuild -> dist/renderer.bundle.js)
├── src/renderer/index.js            # Module loader & initialization
├── src/renderer/core/               # DI container, BaseService/Component/Panel, ApiProvider
├── src/renderer/state/              # 12 observable state modules
├── src/renderer/services/           # 19 services + modular markdown renderer
├── src/renderer/ui/components/      # 11 UI components
├── src/renderer/ui/panels/          # 20 UI panels
├── src/renderer/features/           # Keyboard shortcuts, quick picker, drag-drop
├── src/renderer/events/             # Claude event bus (hook + scraping providers)
├── src/renderer/workflow-fields/    # 14 custom UI fields for workflow nodes
├── src/renderer/workflow-triggers/  # Renderer-side trigger configurators
├── src/renderer/viewers/            # PDF viewer + 3D (three.js) viewer
├── src/renderer/i18n/               # EN/FR/ES locales (~1400 keys each)
└── src/renderer/utils/              # DOM, color, format, paths, icons, syntax highlighting

Project Types (Plugin System)
└── src/project-types/               # general, api, fivem, minecraft, python, webapp, discord

Shared code
└── src/shared/                      # workflow-schema.js shared between main and renderer

Styles
└── styles/                          # 26 modular CSS files (~50,700 lines total)

MCP Servers (shipped with the app)
└── resources/mcp-servers/
    ├── claude-terminal-mcp.js       # Unified MCP server
    ├── database-mcp-server.js       # Specialized DB server
    └── tools/                       # 19 tool modules (auto-registered)

Remote UI (PWA for mobile)
└── remote-ui/                       # Web interface bundled as extraResources
```

## Main Process (`src/main/`)

### IPC Handlers (`src/main/ipc/`)

| File | Handlers | Key Operations |
|------|---------:|----------------|
| `terminal.ipc.js` | 4 | Create PTY (node-pty), input, resize, kill |
| `git.ipc.js` | 69 | Status, branches, pull/push/merge/rebase, clone, stash, cherry-pick, revert, tag, blame, worktree, AI commit message, PR description, inline diff |
| `github.ipc.js` | 26 | OAuth Device Flow, workflow runs, PRs, issues, reviews, GitHub Enterprise, repo search |
| `chat.ipc.js` | 16 | Agent SDK streaming sessions, permissions, interrupt, model/effort switching, tab name generation, fork/rewind, skill/agent generation, session recap |
| `dialog.ipc.js` | 21 | Window controls, file/folder dialogs, open in explorer/editor/browser, notifications, updates, startup, clipboard |
| `explorer.ipc.js` | 3 | File explorer watcher (start/stop/onChanges) |
| `mcp.ipc.js` | 2 | Start/stop MCP server processes |
| `mcpRegistry.ipc.js` | 3 | Browse/search/detail `registry.modelcontextprotocol.io` |
| `marketplace.ipc.js` | 7 | Skills search/featured/readme/install/uninstall from `skills.sh` |
| `plugin.ipc.js` | 8 | Installed plugins, catalog, marketplaces, install/uninstall via Claude CLI PTY |
| `usage.ipc.js` | 4 | Claude usage data (OAuth API primary, PTY `/usage` fallback), monitor |
| `claude.ipc.js` | 5 | Session listing, conversation history, Control Tower agent supervision |
| `project.ipc.js` | 1 | TODO/FIXME/HACK/XXX scanning, project stats |
| `hooks.ipc.js` | 5 | Install/remove/status/verify hooks in `~/.claude/settings.json` |
| `remote.ipc.js` | 11 | PIN auth, WS server info/start/stop, notify projects/session/tab/time |
| `workflow.ipc.js` | 18 | Create/list/run/cancel workflows, run logs, diagnose, variables, test node |
| `workspace.ipc.js` | 7 | Workspace list/overview/search/read/write docs/concept links |
| `parallel.ipc.js` | 9 | Parallel task orchestration across git worktrees |
| `database.ipc.js` | 11 | Multi-driver queries (SQLite/MySQL/PostgreSQL/MongoDB/Redis), schema, export |
| `cloud-relay.ipc.js` | 5 | Cloud relay WSS connection |
| `cloud-sync.ipc.js` | 8 | Bidirectional desktop <-> cloud sync with per-entity toggles |
| `cloud-projects.ipc.js` | 11 | Cloud project upload / download / listing |
| `time.ipc.js` | 1 | Time tracking snapshot |
| `telemetry.ipc.js` | 1 | Opt-in anonymous telemetry |
| `fivem.ipc.js` | - | Delegated to `src/project-types/fivem/` |
| `index.js` | - | Orchestrator - registers all handlers |

**Total: 256 IPC handlers across 26 files.**

### Services (`src/main/services/`)

| Service | Purpose |
|---------|---------|
| `TerminalService.js` | node-pty management, adaptive output batching (4/16/32 ms), Claude CLI launch with `--resume` |
| `ChatService.js` | Claude Agent SDK bridge: streaming input mode, `maxTurns: 100`, permission forwarding, persistent haiku naming session, fork/rewind |
| `GitHubAuthService.js` | GitHub OAuth Device Flow + API, keytar storage, GitHub Enterprise support (Client ID: `Ov23liYfl42qwDVVk99l`) |
| `UsageService.js` | Claude usage via OAuth API (`api.anthropic.com/api/oauth/usage`) with PTY fallback, 5 min staleness |
| `McpService.js` | MCP server child process spawning with env vars, force-kill via taskkill |
| `MarketplaceService.js` | Skill marketplace (`skills.sh/api/search`), git clone install, caching (5-30 min TTL) |
| `McpRegistryService.js` | MCP server registry browsing (`registry.modelcontextprotocol.io/v0.1`), pagination, caching |
| `PluginService.js` | Read plugin metadata, PTY-based `/plugin install` |
| `UpdaterService.js` | electron-updater, 30 min periodic checks, stale cache cleanup |
| `HooksService.js` | 15 Claude hook types, non-destructive install, auto-backup/repair |
| `HookEventServer.js` | HTTP server on `127.0.0.1:0`, receives POST from hook handler |
| `RemoteServer.js` | WebSocket + HTTP for PWA, dynamic port, 6-digit PIN auth, broadcast updates |
| `DatabaseService.js` | Multi-driver pooling (SQLite/MySQL/PostgreSQL/MongoDB/Redis), schema, idle eviction |
| `WorkflowService.js` | Workflow automation orchestrator (central) |
| `WorkflowRunner.js` | Execute a single workflow run (variables, conditions, data flow) |
| `WorkflowScheduler.js` | Trigger management (cron, webhook, hook, on_workflow) |
| `WorkflowStorage.js` | Persist workflow definitions + run history |
| `ParallelTaskService.js` | Decompose a feature into independent sub-tasks, one git worktree + branch each, AI merge agent |
| `WorkspaceService.js` | Workspace knowledge base: docs, concept links, full-text search |
| `CloudRelayClient.js` | WSS client to self-hosted cloud relay |
| `SyncEngine.js` | Bidirectional desktop <-> cloud sync, conflict resolution, file watcher, per-entity toggles |
| `TelemetryService.js` | Opt-in anonymous telemetry |
| `FivemService.js` | Re-export (delegated to `src/project-types/fivem`) |

### Windows (`src/main/windows/`)

| Window | Purpose |
|--------|---------|
| `MainWindow.js` | 1400x900, frameless, tray minimize, `Ctrl+Arrow` tab navigation |
| `QuickPickerWindow.js` | 600x400, always-on-top, transparent - Command Palette (`Ctrl+P` / `Ctrl+Shift+P`) |
| `SetupWizardWindow.js` | 900x650, 7-step first-launch wizard |
| `TrayManager.js` | System tray with context menu (Open, Quick Pick, New Terminal, Quit) |
| `NotificationWindow.js` | Custom toast with stacking, click-through transparency, action buttons |

### Utilities (`src/main/utils/`)

| Utility | Purpose |
|---------|---------|
| `paths.js` | Path constants (`~/.claude-terminal/`, `~/.claude/`), `ensureDataDir()`, `loadAccentColor()` |
| `git.js` | 20+ git operations via `execGit()`, status parsing, safe.directory, 15s timeout, worktree support |
| `commitMessageGenerator.js` | AI commit via GitHub Models API (gpt-4o-mini), heuristic fallback |
| `prDescriptionGenerator.js` | AI-generated PR descriptions |
| `shell.js` | Shell utilities, PATH resolution (macOS/Linux) |
| `httpCache.js` | Disk HTTP response cache |
| `machineId.js` | Stable machine identifier (telemetry + relay) |
| `zipProject.js` | Zip project for cloud upload (`archiver`) |
| `formatDuration.js` | Duration formatting helper |

### Workflow Engine (`src/main/workflow-nodes/`, `src/main/workflow-triggers/`)

**21 node types:** `trigger`, `shell`, `claude`, `condition`, `loop`, `git`, `http`, `db`, `file`, `notify`, `log`, `variable`, `get_variable`, `transform`, `switch`, `wait`, `time`, `project`, `subworkflow`, `webhook`, plus `_registry.js`.

**6 trigger types:** `manual`, `cron`, `hook`, `webhook`, `on_workflow`, plus `_registry.js`.

Each node exports a schema + `execute(inputs, context)`; nodes are auto-registered via `_registry.js`.

## Renderer Process (`src/renderer/`)

### Initialization Flow (`src/renderer/index.js`)

1. Platform detection (class `platform-{win32|darwin|linux}` on body)
2. `utils.ensureDirectories()` - create data dirs
3. `state.initializeState()` - load all state modules
4. Load i18n with saved language or auto-detect
5. Initialize settings (apply accent color, custom agent/tool colors)
6. Register MCP, WebApp, FiveM, Workflow, Cloud event listeners
7. Initialize Claude event bus (hooks/scraping providers)
8. Load disk-cached dashboard data
9. Preload all projects (500 ms delay)

### Core (`src/renderer/core/`)

- `ServiceContainer.js` - lightweight DI container
- `BaseService.js`, `BaseComponent.js`, `BasePanel.js` - base classes
- `ApiProvider.js` - global API/IPC provider

### State Management (`src/renderer/state/`)

Base class `State.js`: observable, `subscribe()`, batched notifications via `requestAnimationFrame`.

| Module | Key state |
|--------|-----------|
| `projects.state.js` | projects[], folders[], rootOrder[], selectedProjectFilter, openedProjectId - CRUD, folder nesting, atomic writes |
| `terminals.state.js` | terminals Map, activeTerminal, detailTerminal |
| `settings.state.js` | editor, accentColor, language, defaultTerminalMode, chatModel, pinnedTabs, sidebarOrder, shortcuts |
| `timeTracking.state.js` | per-session, 15 min idle, midnight rollover, monthly archival |
| `mcp.state.js` | mcps[], mcpProcesses, selectedMcp, 1000-entry log limit |
| `git.state.js` | gitOperations Map, gitRepoStatus Map |
| `fivem.state.js` | FiveM resource scanning state |
| `database.state.js` | Active connections, queries, schema |
| `workflows.state.js` | Workflow definitions, runs, history |
| `workspace.state.js` | Workspaces, KB docs, concept links, search |
| `parallelTask.state.js` | Parallel runs, tasks, branches |

### Services (`src/renderer/services/`)

| Service | Purpose |
|---------|---------|
| `TerminalService.js` | xterm.js + WebGL (10k scrollback), mount, fit, IPC wrappers |
| `ProjectService.js` | Add/delete/open projects, editor integration, git status check |
| `SettingsService.js` | Accent color DOM application, notification permissions, window title |
| `DashboardService.js` | `buildXxxHtml()` helpers, data caching (30s TTL), disk cache |
| `TimeTrackingDashboard.js` | Charts & stats |
| `GitTabService.js` | Git UI helpers, status display |
| `McpService.js` | Load/save MCP configs from `~/.claude.json` |
| `SkillService.js` | Load skills from `~/.claude/skills/` with YAML frontmatter |
| `AgentService.js` | Load agents from `~/.claude/agents/` |
| `ArchiveService.js` | Monthly time tracking archival |
| `FivemService.js` | FiveM IPC wrapper |
| `ContextPromptService.js` | Library: context packs + prompt templates |
| `MarkdownRenderer.js` | Rich markdown with mermaid, katex, trees, timelines, compare, metrics, discord blocks, workspace blocks, parallel blocks, etc. |
| `NodeRegistry.js` | Cache workflow node schemas |
| `WorkflowGraphEngine.js` | LiteGraph-based graph editor for workflows |
| `WorkflowSchemaCache.js` | Workflow schema cache |
| `SessionRecapService.js` | Auto-generated session summaries |
| `TerminalSessionService.js` | Session naming, pins, history |
| `BuiltinSystemPrompts.js` | Built-in system prompts |
| `markdown/` | Modular renderer subsystem (configure, streaming, postProcess, interactivity, blocks) |

### UI Components (`src/renderer/ui/components/`)

`ProjectList`, `TerminalManager`, `ChatView`, `FileExplorer`, `Modal`, `CustomizePicker`, `QuickActions`, `ContextMenu`, `Tab`, `Toast`, `ClaudeMdSuggestionModal`.

### UI Panels (`src/renderer/ui/panels/`)

| Panel | Purpose |
|-------|---------|
| `SettingsPanel` | App settings, accent color, language, editor, startup, hooks |
| `GitChangesPanel` | Git status, staging, commit, push/pull, inline diff viewer, worktree switcher |
| `McpPanel` | MCP servers (start/stop, config, logs) |
| `PluginsPanel` | Claude Code plugins (browse, install, uninstall, update checks) |
| `SkillsAgentsPanel` | Skills + agents library with syntax-highlighted editor |
| `MarketplacePanel` | Skill marketplace search + install |
| `MemoryEditor` | Edit global / settings / project `CLAUDE.md` |
| `ShortcutsManager` | Customizable keyboard shortcuts |
| `RemotePanel` | Remote control (PIN, QR code, server status) |
| `ControlTowerPanel` | Real-time overview of all active Claude agents, remote interrupt, reply to AskUserQuestion |
| `ParallelTaskPanel` | Parallel run orchestration (start/cancel/merge/cleanup), per-task diff, terminal |
| `SessionReplayPanel` | Timeline replay of past sessions, video-scrubber, Q&A cards |
| `WorkflowPanel` | Visual node-based workflow editor (LiteGraph), run history, AI assistant |
| `WorkflowMarketplacePanel` | Share / import workflows |
| `WorkflowHelpers.js` | Helpers for the workflow panel |
| `WorkspacePanel` | Workspace KB + advisor chat + concept links |
| `DatabasePanel` | Multi-driver data browser, SQL editor, Redis tree-view |
| `KanbanPanel` | Kanban board (tasks by column) |
| `CloudPanel` | Cloud sync with per-entity toggles, project upload/download, diff modal |
| `ConnectivityPanel` | Unified local remote + cloud connectivity status |

### Features (`src/renderer/features/`)

| Feature | Role |
|---------|------|
| `KeyboardShortcuts.js` | `Ctrl+T` new terminal, `Ctrl+W` close, `Ctrl+P` command palette, `Ctrl+,` settings, `Ctrl+Tab`/`Ctrl+Shift+Tab` terminals, `Ctrl+Shift+E` sessions, `Ctrl+Arrow` switch terminal/project, `Escape` close overlays |
| `QuickPicker.js` | Command Palette - fuzzy search over projects, commands, quick actions |
| `DragDrop.js` | HTML5 drag-drop for projects/folders + files-from-explorer into chat |

**Global shortcuts** (main process): `Ctrl+Shift+P` quick picker, `Ctrl+Shift+T` new terminal.

### Events System (`src/renderer/events/`)

| Module | Purpose |
|--------|---------|
| `ClaudeEventBus.js` | Pub-sub for SESSION_START/END, TOOL_START/END, PROMPT_SUBMIT |
| `HooksProvider.js` | Event detection via Claude hooks (HTTP event server) |
| `ScrapingProvider.js` | Fallback event detection via terminal output parsing |
| `index.js` | Provider selection, wires consumers (time tracking, notifications, dashboard) |

### Workflow UI (`src/renderer/workflow-fields/`, `src/renderer/workflow-triggers/`)

**14 custom fields:** `agent-picker`, `claude-config`, `cron-picker`, `cwd-picker`, `db-config`, `loop-config`, `project-config`, `skill-picker`, `sql-editor`, `subworkflow-picker`, `time-config`, `trigger-config`, `variable-autocomplete`, plus `_registry.js`.

**Trigger configurators:** `manual`, `cron`, `hook`, `webhook`, `on_workflow` + `_registry.js`.

### Viewers (`src/renderer/viewers/`)

- `pdf-viewer.js` - PDF rendering via `pdfjs-dist`
- `three-viewer.js` - 3D model (.glb/.gltf/.obj) via `three`

### Internationalization (`src/renderer/i18n/locales/`)

- **Languages:** English (base), French, Spanish (`en.json`, `fr.json`, `es.json`)
- **Keys:** ~1400 per locale
- **Detection:** auto-detect from `navigator.language`, fallback to `fr`
- **Usage:** `t('projects.openFolder')`, `t('key', { count: 5 })`, `data-i18n="..."` for static HTML
- Error messages in main process must be in English.

## Project Types (`src/project-types/`)

Pluggable type system: `base-type.js` + `registry.js`. Types: `general`, `api`, `fivem`, `minecraft`, `python`, `webapp`, `discord`.

Each type typically provides `main/[Type]Service.js`, `main/[type].ipc.js`, `renderer/[Type]Dashboard.js`, `renderer/[Type]ProjectList.js`, `renderer/[Type]RendererService.js`, `renderer/[Type]State.js`, `renderer/[Type]TerminalPanel.js`, `renderer/[Type]Wizard.js`, `i18n/{en,fr,es}.json`.

**Discord** also ships a code generator, embed builder, and component builder for visual Discord bot development.

## Remote Control & Cloud

- **`remote-ui/`** - PWA (`app.js`, `index.html`, `style.css`, `sw.js`, `manifest.json`, `i18n.js`, icons). Bundled as `extraResources`.
- **`RemoteServer.js`** - Dynamic-port WebSocket server, 6-digit PIN auth, QR code via `qrcode` package.
- **`CloudRelayClient.js`** - Self-hosted Docker relay (WSS), allows remote-ui access outside local Wi-Fi.
- **`SyncEngine.js`** - Bidirectional desktop <-> cloud sync. Per-entity toggles: projects, settings, skills, agents, MCP configs, keybindings, memory, hooks, archives. File watcher with conflict diff modal.
- **Cross-machine notifications** - Desktop notifications when a cloud session finishes.
- **Session resume from cloud** - Pick up any session from another machine.

## HTML Pages

| File | Lines | Purpose |
|------|------:|---------|
| `index.html` | 979 | Main app: titlebar, sidebar (customizable + pinned tabs), content panels, modals |
| `quick-picker.html` | 531 | Command Palette (inline Node script) |
| `setup-wizard.html` | 1642 | 7-step onboarding with embedded EN/FR translations |
| `notification.html` | 262 | Custom toast with auto-dismiss progress bar |

## CSS Architecture (`styles/` - 26 files, ~50,700 lines)

### CSS Variables (`:root` in `base.css`)

```css
/* Colors */
--bg-primary: #0d0d0d;  --bg-secondary: #151515;  --bg-tertiary: #1a1a1a;
--bg-hover: #252525;    --bg-active: #2a2a2a;     --border-color: #2d2d2d;
--text-primary: #e0e0e0; --text-secondary: #888;   --text-muted: #555;
--accent: #d97706;      --accent-hover: #f59e0b;   --accent-dim: rgba(217,119,6,0.15);
--success: #22c55e;     --warning: #f59e0b;        --danger: #ef4444;  --info: #3b82f6;

/* Layout */
--radius: 8px;  --radius-sm: 4px;  --sidebar-width: 200px;  --projects-panel-width: 350px;

/* Typography (rem-based) */
--font-2xs: 0.625rem;  --font-xs: 0.6875rem;  --font-sm: 0.8125rem;
--font-base: 0.875rem; --font-md: 1rem;       --font-lg: 1.125rem;
```

### CSS Files (biggest first)

| File | Lines | Section |
|------|------:|---------|
| `workflow.css` | 6979 | Visual workflow editor (LiteGraph) |
| `git.css` | 4229 | Git panel, diff view, worktrees, commit graph |
| `projects.css` | 3828 | Project list, tree, drag-drop, customize |
| `chat.css` | 3640 | Chat UI, messages, permissions, thinking, subagents |
| `settings.css` | 2924 | Settings forms |
| `database.css` | 2885 | DB panel, SQL editor, Redis tree |
| `dashboard.css` | 2459 | Stats cards, heatmap, health badges |
| `markdown-blocks.css` | 2377 | Custom markdown blocks |
| `terminal.css` | 2365 | xterm, tabs, loading |
| `parallel.css` | 2288 | Parallel tasks |
| `modals.css` | 2205 | Modals |
| `fivem.css` | 2097 | FiveM-specific |
| `skills.css` | 1619 | Skills + agents panel |
| `session-replay.css` | 1584 | Session Replay timeline |
| `time-tracking.css` | 1444 | Time tracking charts |
| `layout.css` | 1303 | Sidebar, grid |
| `memory.css` | 869 | CLAUDE.md editor |
| `workspace.css` | 824 | Workspace KB |
| `mcp.css` | 816 | MCP management |
| `cloud.css` | 804 | Cloud sync |
| `discord-theme.css` | 739 | Discord builder theme |
| `kanban.css` | 692 | Kanban board |
| `litegraph.css` | 680 | LiteGraph vendor styles |
| `control-tower.css` | 525 | Control Tower |
| `xterm.css` | 285 | xterm vendor |
| `base.css` | 252 | Variables, fonts, reset |

### Naming Convention

```css
.component-name { }            /* Base */
.component-name.state { }      /* State modifier (e.g. .project-item.active) */
.component-name[data-x] { }    /* Data attribute conditional */
.component-name:has(.child) {} /* Parent selector */
```

## Preload Bridge (`src/main/preload.js`)

Exposes API namespaces on `window.electron_api`:

`terminal` | `git` (69 methods) | `github` | `chat` | `claude` | `mcp` | `mcpRegistry` | `marketplace` | `plugins` | `dialog` | `explorer` | `window` | `app` | `notification` | `usage` | `project` | `hooks` | `updates` | `setupWizard` | `lifecycle` | `quickPicker` | `tray` | `fivem` | `webapp` | `api` | `python` | `minecraft` | `discord` | `remote` | `workspace` | `workflow` | `parallel` | `database` | `time` | `telemetry` | `cloud`

Also exposes `window.electron_nodeModules`: `path`, `fs` (sync + promises), `os.homedir()`, `process.env`, `child_process.execSync`.

## Data Storage

```
~/.claude-terminal/                    # App data directory
├── projects.json                      # Projects with folder hierarchy & quick actions
├── settings.json                      # User preferences (accent, language, editor, shortcuts, pinnedTabs, sidebarOrder)
├── timetracking.json                  # Time tracking data (v2 format)
├── marketplace.json                   # Installed skills manifest
├── session-names.json                 # Session display names
├── session-pins.json                  # Pinned sessions
├── parallel-runs.json                 # Parallel task run history
├── workflows/
│   ├── definitions.json               # Workflow graphs
│   └── triggers/                      # Trigger configs
├── hooks/port                         # Hook event server port file
├── worktrees/{runId}/                 # Git worktrees for parallel runs
└── archives/YYYY/MM/archive-data.json # Archived time tracking sessions

~/.claude/                             # Claude Code directory
├── settings.json                      # Claude Code settings (with hooks)
├── .claude.json                       # MCP server configurations
├── .credentials.json                  # OAuth tokens
├── skills/                            # Installed skills (SKILL.md + files)
├── agents/                            # Custom agents (AGENT.md + files)
├── projects/{encoded-path}/           # Session data per project (.jsonl + index)
└── plugins/                           # Installed plugins + marketplaces

OS credential store (via keytar)       # GitHub token (Windows Credential Manager / macOS Keychain / Linux libsecret)
```

## Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `electron` | ^28.0.0 | Desktop framework (Chromium 120) |
| `@anthropic-ai/claude-agent-sdk` | ^0.2.111 | Claude Code streaming chat |
| `@xterm/xterm` + addons | ^6.0.0 | Terminal emulator (WebGL, fit) |
| `node-pty` | ^1.1.0 | PTY process management |
| `keytar` | ^7.9.0 | OS credential storage |
| `better-sqlite3` | ^11.0.0 | SQLite driver |
| `mysql2` / `pg` / `mongodb` / `ioredis` | - | DB drivers |
| `marked` | ^17.0.3 | Markdown |
| `mermaid` | ^11.13.0 | Diagrams in chat markdown |
| `katex` | ^0.16.38 | Math rendering |
| `highlight.js` | ^11.11.1 | Code syntax |
| `dompurify` | ^3.3.1 | XSS sanitization |
| `pdfjs-dist` | ^5.5.207 | PDF viewer |
| `three` | ^0.183.2 | 3D model viewer |
| `chokidar` | ^5.0.0 | File watcher |
| `archiver` + `extract-zip` | - | Cloud project zip |
| `electron-updater` | ^6.1.7 | Auto-update |
| `ws` | ^8.19.0 | WebSocket (remote + cloud relay) |
| `qrcode` | ^1.5.4 | QR code for remote |
| `esbuild` | ^0.27.2 | Renderer bundling (IIFE, Chrome 120, sourcemaps) |
| `jest` + jsdom | ^29.7.0 | Tests |
| `playwright` | ^1.58.2 | Browser automation (screenshots, axe-core a11y) |
| `sharp` / `ffmpeg-static` | - | Asset + video processing for marketing scripts |

## Key Implementation Details

- **No context isolation:** `contextIsolation: false` + `nodeIntegration: false` with full `electron_api` bridge
- **Single instance:** `app.requestSingleInstanceLock()` prevents multiple instances
- **Tray integration:** close button minimizes to tray, `app-quit` for real exit
- **Frameless window:** custom titlebar in HTML/CSS with `-webkit-app-region: drag`
- **Terminal:** xterm.js (WebGL) in renderer, node-pty (PowerShell default) in main, adaptive batching
- **Chat:** Agent SDK streaming input mode, async iterator, multi-turn, fork/rewind via SDK checkpointing
- **AI commits / PR descriptions:** GitHub Models API (`gpt-4o-mini`, free tier) with heuristic fallback
- **Hooks:** 15 hook types into `~/.claude/settings.json`, HTTP event server for real-time events
- **Time tracking:** 15 min idle timeout, 2 min output idle, 30 min session merge, midnight rollover, monthly archival
- **Renderer bundling:** esbuild IIFE -> `dist/renderer.bundle.js` with sourcemaps, target `chrome120`
- **Persistence:** atomic writes (temp + rename), `.bak` backup files, corruption recovery
- **Updates:** generic provider, 30 min periodic checks, differential packages
- **Remote control:** WS server with PIN auth, QR code, PWA in `remote-ui/`
- **Cloud sync:** self-hosted Docker relay, per-entity toggles, file watcher, conflict diff modal
- **Parallel tasks:** git worktrees per sub-task, AI merge agent, persisted run state
- **Workflows:** LiteGraph editor, 21 nodes / 6 trigger types, AI assistant for graph editing, webhook/cron/hook triggers
- **Workspace:** cross-project KB with advisor chat, concept links, `@workspace` mention
- **Security:** `dompurify` for all user-rendered markdown; never inject untrusted HTML into chat/dashboard

## Testing

```bash
npm test                    # Run all tests (jsdom environment)
npm run test:watch          # Watch mode
```

- **Framework:** Jest with jsdom
- **Setup:** `tests/setup.js` mocks `window.electron_nodeModules`, `window.electron_api`, `requestAnimationFrame`
- **Pattern:** `**/tests/**/*.test.js`
- **Directories:**
  - `core/` - BaseComponent, BasePanel, ApiProvider, ServiceContainer
  - `features/` - KeyboardShortcuts
  - `i18n/` - i18n + i18n coherence
  - `integration/` - state persistence
  - `ipc/` - hooks, project, usage
  - `remote-ui/` - hierarchy
  - `security/` - security tests
  - `services/` - ChatService, DatabaseService, DashboardService, HooksService, MarkdownRenderer, RemoteServer, WorkflowRunner
  - `state/` - State, database, git, mcp, projects, settings, terminals, timeTracking, workflows
  - `utils/` - color, commitMessageGenerator, dropPaths, fileIcons, format, formatDuration, frontmatter, git, httpCache, shell, syntaxHighlight

## CI/CD

**GitHub Actions (`.github/workflows/`):**

- `ci.yml` - triggers on push to `main` and PRs. Matrix: Node 18 + 20 on windows-latest, ubuntu-latest, macos-latest. Steps: `checkout`, `npm ci`, `build:renderer`, `test`.
- `release.yml` - triggers on `v*` tags. Builds NSIS (Windows x64), DMG (macOS arm64 + x64), AppImage (Linux x64).
- `i18n-badge.yml` - updates i18n coverage badges (gist `ec1241ea62520261790ef5a411b4b212`).

**Installer:** electron-builder config in `electron-builder.config.js`. AppId: `com.yanis.claude-terminal`. NSIS per-user install. Publishes to GitHub releases.

## Bundled Resources

- `resources/bundled-skills/` - `create-skill`, `create-agents` guides
- `resources/hooks/claude-terminal-hook-handler.js` - Node script called by Claude hooks, POSTs events over HTTP
- `resources/mcp-servers/` - shipped MCP servers (see below)
- `assets/` - `icon.ico`, `icon.png`, `claude-mascot.svg`, `mascot-dance.svg`
- `website/` - landing page, changelog, privacy, legal, mascot demo, OG generator
- `remote-ui/` - PWA bundled via `extraResources`

## MCP Tools (`resources/mcp-servers/`)

Claude Terminal ships its own unified MCP server (`claude-terminal-mcp.js`), auto-configured by the app. Tool modules are loaded dynamically from `resources/mcp-servers/tools/` - a new `.js` file there is auto-registered. A specialized `database-mcp-server.js` is also shipped.

**Tool module interface:**
```javascript
module.exports = {
  tools: [{ name, description, inputSchema }],
  handle: async (toolName, args) => ({ content: [{ type: 'text', text }], isError? }),
  cleanup: async () => {}
};
```

**Env vars available in MCP tools:** `CT_DATA_DIR` (`~/.claude-terminal/`), `CT_PROJECT_PATH` (current project).

**Available tool modules (19):**

| Module | Key tools |
|--------|-----------|
| `projects.js` | `project_list`, `project_info`, `project_todos` |
| `timetracking.js` | `time_today`, `time_week`, `time_summary`, `time_project` |
| `sessions.js` | `session_list`, `session_replay` |
| `database.js` | `db_query`, `db_list_tables`, `db_describe_table`, `db_schema_full`, `db_stats`, `db_export` |
| `webapp.js` | `webapp_stack`, `webapp_scripts`, `webapp_start`, `webapp_stop` |
| `fivem.js` | `fivem_command`, `fivem_list_resources`, `fivem_read_manifest`, `fivem_resource_files`, `fivem_server_cfg` |
| `discord.js` | `discord_bot_status`, `discord_list_commands` |
| `workflow.js` | Create/list/run/cancel/diagnose + run logs + variables |
| `parallel.js` | `parallel_list_runs`, `parallel_run_detail`, `parallel_start_run`, `parallel_cancel_run`, `parallel_cleanup_run`, `parallel_merge_run` |
| `workspace.js` | `workspace_list`, `workspace_info`, `workspace_read_doc`, `workspace_write_doc`, `workspace_search`, `workspace_add_link` |
| `control-tower.js` | `control_tower_agents`, `control_tower_interrupt` |
| `kanban.js` | Kanban columns + tasks (add / move / update / filter / stats) |
| `terminal.js` | `terminal_create`, `terminal_list`, `terminal_send_command`, `terminal_read_output`, `terminal_close` |
| `tabs.js` | Tab orchestration with permission control |
| `sidebar.js` | `sidebar_get_pinned`, `sidebar_set_pinned` |
| `marketplace.js` | Skill marketplace tools |
| `plugins.js` | Plugin install / list / catalog |
| `settings.js` | `settings_get`, `settings_set` |
| `usage.js` | `usage_get`, `usage_refresh` |

## Conventions

- **Commits:** `feat(scope): description` in English, imperative mood
- **IPC pattern:** Service (main) -> IPC handler -> Preload bridge -> Renderer service
- **Dashboard sections:** `buildXxxHtml()` in `DashboardService.js`
- **CSS:** `.component-name.state` pattern, CSS variables, 26 modular files in `styles/`
- **i18n:** add keys to `en.json`, `fr.json`, and `es.json`; use `t('dot.path')`. Main-process error messages stay in English.
- **State updates:** `state.set()` / `state.setProp()`, subscribe with `state.subscribe()`
- **File I/O:** atomic writes for user data (temp + rename), `.bak` backup
- **Project types:** extend `base-type.js`, register in `registry.js`, provide service + IPC + dashboard + i18n
- **Markdown:** prefer the rich custom blocks (tree, timeline, compare, metrics, api, tabs, discord-embed, workspace-doc, git-commit, workspace-links...) over plain bullet lists.
- **Security:** sanitize user-supplied markdown with `dompurify`; never inject untrusted HTML into chat or dashboard panels.
