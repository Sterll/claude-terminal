# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Terminal is a cross-platform Electron desktop application (**v1.3.2**) for managing Claude Code projects. It bundles an integrated terminal, a Claude Agent SDK chat UI, full Git workflow, a visual workflow automation editor, parallel task orchestration, a Control Tower for multi-agent supervision, a workspace knowledge base, multi-account Claude switching, voice dictation, an artifact library, cloud sync, a PWA remote control, and a plugin/skill ecosystem. Primary target: Windows 10/11 with NSIS installer. Also builds for macOS (DMG) and Linux (AppImage / Snap / Flatpak).

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
npm test                 # Run Jest tests (jsdom, 136 test files)
npm run test:watch       # Jest in watch mode
npm run check:docs       # Fail if CLAUDE.md has drifted from the tree it describes
npm run lint             # ESLint over main, renderer, shared, MCP servers and scripts
npm run lint:fix         # ESLint with --fix
npm run test:e2e         # Playwright smoke test against the real Electron app
```

**Important:** Always run `npm run build:renderer` after modifying anything under `src/renderer/`, `src/project-types/`, or `renderer.js`.

## Architecture Overview

```
Electron Main Process (Node.js)
├── main.js                          # Bootstrap, lifecycle, single-instance lock, global shortcuts
├── src/main/preload.js              # IPC bridge (window.electron_api)
├── src/main/preload-quickpicker.js  # Preload for Quick Picker window
├── src/main/ipc/                    # 35 IPC files, 322 handlers total
├── src/main/services/               # 34 services
├── src/main/windows/                # 5 window managers
├── src/main/utils/                  # 13 utilities
└── src/main/workflow-nodes/         # 31 workflow node types (*.node.js)

Electron Renderer Process (Browser)
├── renderer.js                      # Entry point (bundled by esbuild -> dist/renderer.bundle.js)
├── src/renderer/index.js            # Module loader & initialization
├── src/renderer/core/               # DI container, BaseService/Component/Panel, ApiProvider
├── src/renderer/state/              # 15 observable state modules
├── src/renderer/services/           # 27 services + modular markdown renderer + mention sources
├── src/renderer/ui/components/      # 17 UI components
├── src/renderer/ui/panels/          # 25 UI panels
├── src/renderer/features/           # Keyboard shortcuts, quick picker, drag-drop
├── src/renderer/events/             # Claude event bus (hook + scraping providers)
├── src/renderer/workflow-fields/    # 13 custom UI fields for workflow nodes
├── src/renderer/workflow-triggers/  # 12 trigger types (definition + configurator)
├── src/renderer/viewers/            # PDF viewer + 3D (three.js) viewer
├── src/renderer/i18n/               # EN/FR/ES/ID/zh-CN locales (3641 keys each)
└── src/renderer/utils/              # DOM, color, format, paths, icons, syntax highlighting

Project Types (Plugin System)
└── src/project-types/               # general, api, fivem, minecraft, python, webapp, discord

Shared code
└── src/shared/                      # 12 modules shared between main, renderer and the MCP server

Styles
└── styles/                          # 30 modular CSS files (~57,000 lines total)

MCP Servers (shipped with the app)
└── resources/mcp-servers/
    ├── claude-terminal-mcp.js       # Unified MCP server
    ├── database-mcp-server.js       # Specialized DB server
    └── tools/                       # 23 tool modules (auto-registered) + 3 shared helpers

Remote UI (PWA for mobile)
└── remote-ui/                       # Web interface bundled as extraResources
```

## Main Process (`src/main/`)

### IPC Handlers (`src/main/ipc/`)

| File | Handlers | Key Operations |
|------|---------:|----------------|
| `terminal.ipc.js` | 4 | Create PTY (node-pty), input, resize, kill |
| `git.ipc.js` | 69 | Status, branches, pull/push/merge/rebase, clone, stash, cherry-pick, revert, tag, blame, worktree, AI commit message, PR description, inline diff |
| `chat.ipc.js` | 26 | Agent SDK streaming sessions, permissions, interrupt, model/effort/permission-mode switching, tab name generation, fork/rewind, skill/agent generation, session recap |
| `github.ipc.js` | 25 | OAuth Device Flow, workflow runs, PRs, issues, reviews, GitHub Enterprise, repo search |
| `dialog.ipc.js` | 23 | Window controls, file/folder dialogs, open in explorer/editor/browser, notifications, updates + release notes, startup, clipboard |
| `workflow.ipc.js` | 19 | Create/list/run/cancel workflows, run logs, diagnose, variables, test node |
| `remote.ipc.js` | 11 | PIN auth, WS server info/start/stop, notify projects/session/tab/time |
| `database.ipc.js` | 11 | Multi-driver queries (SQLite/MySQL/PostgreSQL/MongoDB/Redis), schema, export |
| `cloud-projects.ipc.js` | 11 | Cloud project upload / download / listing |
| `parallel.ipc.js` | 9 | Parallel task orchestration across git worktrees |
| `knowledge.ipc.js` | 9 | Global knowledge CRUD, pin, enable, search, CLAUDE.md block preview/sync |
| `accounts.ipc.js` | 9 | Multiple Claude accounts: capture, list, switch, rename, delete, per-project binding |
| `plugin.ipc.js` | 8 | Installed plugins, catalog, marketplaces, install/uninstall via Claude CLI PTY |
| `cloud-sync.ipc.js` | 8 | Bidirectional desktop <-> cloud sync with per-entity toggles |
| `artifacts.ipc.js` | 8 | Artifact library: list, get, versions, search, stats, delete |
| `workspace.ipc.js` | 7 | Workspace list/overview/search/read/write docs/concept links |
| `marketplace.ipc.js` | 7 | Skills search/featured/readme/install/uninstall from `skills.sh` |
| `claude.ipc.js` | 7 | Session listing, conversation history, move session, Control Tower agent supervision |
| `voice.ipc.js` | 6 | Groq transcription, API key in the OS credential store, model selection |
| `remote-control.ipc.js` | 6 | Claude Remote Control (claude.ai bridge): status, enable/disable per session |
| `errorLog.ipc.js` | 6 | Error log entries, stats, patterns, export, clear |
| `usage.ipc.js` | 5 | Claude usage data (OAuth API primary, PTY `/usage` fallback), monitor |
| `hooks.ipc.js` | 5 | Install/remove/status/verify hooks in `~/.claude/settings.json` |
| `cloud-relay.ipc.js` | 5 | Cloud relay WSS connection |
| `chrome.ipc.js` | 4 | Claude in Chrome: status, install/remove native messaging host, open the extension page |
| `mcpRegistry.ipc.js` | 3 | Browse/search/detail `registry.modelcontextprotocol.io` |
| `explorer.ipc.js` | 3 | File explorer watcher (start/stop/onChanges) |
| `mcp.ipc.js` | 2 | Start/stop MCP server processes |
| `discord-rpc.ipc.js` | 2 | Discord Rich Presence enable/disable |
| `project.ipc.js` | 1 | TODO/FIXME/HACK/XXX scanning, project stats |
| `time.ipc.js` | 1 | Time tracking snapshot |
| `telemetry.ipc.js` | 1 | Opt-in anonymous telemetry |
| `preview.ipc.js` | 1 | Serves ```html markdown blocks over the `ct-preview://` scheme (see below) |
| `fivem.ipc.js` | - | Delegated to `src/project-types/fivem/` |
| `cloud-shared.js` | - | Helpers shared by the three cloud IPC files |
| `index.js` | - | Orchestrator - registers all handlers |

**Total: 322 IPC handlers across 35 files.**

### Services (`src/main/services/`)

| Service | Purpose |
|---------|---------|
| `AccountManager.js` | Multiple Claude OAuth accounts: snapshots the CLI's live credential store into `~/.claude-terminal/accounts/` and swaps the active credentials on demand. The live store is the macOS login Keychain on darwin, `~/.claude/.credentials.json` elsewhere. Login itself stays the CLI's job (`claude /login` once, then capture) |
| `ArtifactService.js` | Main-process facade over `src/shared/artifact-store.js` (shared verbatim with the MCP server process). Adds the two things only main can do: broadcast `artifacts-changed` to every window, and poll for out-of-process writes from the MCP tools |
| `ModelCatalogService.js` | Builds the chat picker's two-tier model catalog: `primary` from whatever the CLI advertises (`initializationResult().models`) minus its `default` alias, `legacy` from the hand-curated list minus anything primary already covers. Follows CLI upgrades on its own, which is the point - hard-coded lists went stale the day Fable 5.1 shipped |
| `VoiceService.js` | Speech-to-text. The renderer captures the mic and hands over raw PCM; anything needing a secret or the network happens here. Groq is the only backend for now (a local Whisper burns CPU exactly when the user is gaming and is worse in French). The API key lives in the OS credential store, never in settings.json, and is never sent to the renderer |
| `ErrorLogService.js` | Centralized error collection, classification and pattern detection. Captures IPC/service errors, uncaught exceptions/rejections, and every `console.error`/`console.warn` from main. `console.error` maps to `warning`, not `critical`: main has ~208 console.error sites and most are caught-and-degraded paths, so `critical` stays reserved for uncaught failures |
| `TerminalOutputCapture.js` | Writes a rolling tail of each project's terminal output to `~/.claude-terminal/terminals/output/<projectId>.log`. That path was already read by the MCP `terminal_read_output` tool and the `terminal` workflow node, but nothing wrote it - this is the missing writer. Buffered and flushed on a timer, capped and trimmed from the head |
| `DiscordRpcService.js` | Discord Rich Presence, VSCode-style. Zero-dependency implementation of the Discord IPC protocol over the local client socket (named pipe on Windows, unix socket elsewhere). Only the public application Client ID is needed; nothing leaves the device |
| `LinuxDesktopIntegration.js` | Registers/updates an XDG `.desktop` file and icon on every Linux launch, so an AppImage shipped without AppImageLauncher still appears in the application menu and survives the versioned-filename change on each release |
| `TerminalService.js` | node-pty management, adaptive output batching (4/16/32 ms), Claude CLI launch with `--resume` |
| `ChatService.js` | Claude Agent SDK bridge: streaming input mode, `maxTurns: 100`, permission forwarding, persistent haiku naming session, fork/rewind |
| `GitHubAuthService.js` | GitHub OAuth Device Flow + API, keytar storage, GitHub Enterprise support (Client ID: `Ov23liYfl42qwDVVk99l`) |
| `UsageService.js` | Claude usage via OAuth API (`api.anthropic.com/api/oauth/usage`) with PTY fallback, 5 min staleness |
| `McpService.js` | MCP server child process spawning with env vars, force-kill via taskkill |
| `MarketplaceService.js` | Skill marketplace (`skills.sh/api/search`), git clone install, caching (5-30 min TTL) |
| `McpRegistryService.js` | MCP server registry browsing (`registry.modelcontextprotocol.io/v0.1`), pagination, caching |
| `PluginService.js` | Read plugin metadata, PTY-based `/plugin install` |
| `UpdaterService.js` | electron-updater, 30 min periodic checks, stale cache cleanup |
| `ChromeBridgeService.js` | Claude in Chrome: detects the browser extension, installs the native messaging host (adopting Claude Code's rather than clobbering it), and hands chat sessions the `claude-in-chrome` MCP server |
| `HooksService.js` | 15 Claude hook types, non-destructive install, auto-backup/repair |
| `HookEventServer.js` | HTTP server on `127.0.0.1:0`, receives POST from hook handler |
| `RemoteServer.js` | WebSocket + HTTP for PWA, dynamic port, 6-digit PIN auth, broadcast updates |
| `RemoteControlService.js` | Claude Code Remote Control: mirrors chat sessions to claude.ai / the Claude mobile app over the SDK bridge, and routes prompts, interrupts and permission answers back |
| `DatabaseService.js` | Multi-driver pooling (SQLite/MySQL/PostgreSQL/MongoDB/Redis), schema, idle eviction |
| `WorkflowService.js` | Workflow automation orchestrator (central) |
| `WorkflowRunner.js` | Execute a single workflow run (variables, conditions, data flow) |
| `WorkflowScheduler.js` | Trigger management (cron, webhook, hook, on_workflow) |
| `WorkflowStorage.js` | Persist workflow definitions + run history |
| `ParallelTaskService.js` | Decompose a feature into independent sub-tasks, one git worktree + branch each, AI merge agent |
| `WorkspaceService.js` | Workspace knowledge base: docs, concept links, full-text search |
| `KnowledgeService.js` | Global knowledge base shared by every project; syncs a marked block into `~/.claude/CLAUDE.md` |
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
| `paths.js` | Path constants (`~/.claude-terminal/`, `~/.claude/`), `ensureDataDir()`, `loadAccentColor()`, `managedSettingsPaths()` |
| `claudeBridge.js` | Dynamic ESM loader for the Agent SDK's Remote Control bridge, with feature detection over its `@alpha` surface |
| `claudeCredentials.js` | Reads/writes the CLI's live credential store across platforms (macOS Keychain vs `~/.claude/.credentials.json`), used by `AccountManager` |
| `sdkCli.js` | Locates the bundled Agent SDK CLI binary, including inside `app.asar.unpacked` |
| `fileLock.js` | Cross-process advisory lock, used by the workflow store and by concurrent settings writers |
| `git.js` | 20+ git operations via `execGit()`, status parsing, safe.directory, 15s timeout, worktree support |
| `commitMessageGenerator.js` | AI commit via GitHub Models API (gpt-4o-mini), heuristic fallback |
| `prDescriptionGenerator.js` | AI-generated PR descriptions |
| `shell.js` | Shell utilities, PATH resolution (macOS/Linux) |
| `httpCache.js` | Disk HTTP response cache |
| `machineId.js` | Stable machine identifier (telemetry + relay) |
| `zipProject.js` | Zip project for cloud upload (`archiver`) |
| `formatDuration.js` | Duration formatting helper |

### Workflow Engine (`src/main/workflow-nodes/`)

**31 node types**, one `*.node.js` file each: `trigger`, `shell`, `claude`, `code`, `condition`, `loop`, `git`, `http`, `db`, `file`, `notify`, `notify_discord`, `log`, `variable`, `get_variable`, `transform`, `switch`, `wait`, `time`, `project`, `subworkflow`, `webhook`, `terminal`, `template`, `retry`, `error_handler`, `parallel_spawn`, `quickaction`, `session_recap`, `kanban_create_card`, `workspace_write_doc`.

Each node exports a schema + `execute(inputs, context)` and is auto-registered by `_registry.js`. `_projects.js` is a shared helper, not a node.

> There is **no** `src/main/workflow-triggers/`. Trigger definitions live entirely on the renderer side, in `src/renderer/workflow-triggers/` - the main process only needs the trigger *type* string, which `WorkflowScheduler` dispatches on.

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
| `projects.state.js` | projects[], folders[], rootOrder[], selectedProjectFilter, openedProjectId - CRUD, folder nesting, atomic writes, three-way merge on save, polled watch for writes from other processes |
| `projects.merge.js` | Three-way merge (base / ours / theirs) for projects.json, so a kanban board or worktree project written by another process survives a save from this renderer |
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
| `accounts.state.js` | Claude accounts, active account, per-project binding, per-account usage |
| `backgroundTasks.state.js` | Background tasks per session, feeding the chat's tasks drawer |
| `errorLog.state.js` | Error log entries, level/domain filters, detected patterns |

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
| `WorkflowGraphEngine.js` | Custom canvas graph editor - a zero-dependency Blueprint-style node editor that **replaced LiteGraph.js**. Split into `GraphModel` (nodes, links, typed pins, serialize), `GraphRenderer` (tinted headers, pins, widgets, links) and `GraphInteraction` (pan, zoom, drag, hit testing) |
| `ProjectTimeline.js` | Merges the six per-project record sets the app keeps in separate screens (commits, sessions, tracked time, workflow runs, parallel runs, artifacts) into one chronological list. Collects nothing new: the work is normalising six record shapes and three spellings of a timestamp onto one `{ ts, kind, title, subtitle }`. Every source loads independently and may fail on its own — a project with no remote, no workflows and no artifacts is the normal case, not an error |
| `DiffRenderer.js` | Renders a unified diff the way GitHub does: two gutters, hunk headers, syntax highlighting, word-level marks. Input is Claude Code's `structuredPatch`, which every file-editing tool call already carries in the transcript |
| `ArtifactService.js` | Renderer side of the artifact library |
| `ModelCatalogClient.js` | Renderer cache over `ModelCatalogService` |
| `VoiceCaptureService.js` | Microphone capture, VAD and PCM hand-off to `VoiceService` in main |
| `MentionSourceRegistry.js` | Pluggable registry feeding **both** the ChatView `@`-mention dropdown (`surface: 'mention'`) and the Ctrl+P quick picker (`surface: 'palette'`). Sources live in `mention-sources/` |
| `BackgroundTaskReconciler.js` | Decides when a background-task card whose end was never announced should be settled anyway. The CLI describes tasks through two feeds: `task_started`/`task_notification` are edge bookends and the only source that knows *how* a task ended; `background_tasks_changed` carries the full live set and is authoritative about *whether* one still runs |
| `IdleAnimationPauser.js` | Pauses every infinite CSS animation while the window is unfocused. A composited animation forces a compositor frame per vsync and the cost grows with document size - on a 68k-node transcript a single 13px spinner cost ~30% of a core. All perpetual animations here are "still working" indicators, so freezing them while the user is elsewhere changes nothing actionable |
| `WorkflowSchemaCache.js` | Workflow schema cache |
| `SessionRecapService.js` | Auto-generated session summaries |
| `TerminalSessionService.js` | Session naming, pins, history |
| `BuiltinSystemPrompts.js` | Built-in system prompts |
| `markdown/` | Modular renderer subsystem (configure, streaming, postProcess, interactivity, blocks) |

### UI Components (`src/renderer/ui/components/`)

`ProjectList`, `ProjectBar`, `TerminalManager`, `ChatView`, `FileExplorer`, `FileViewer`, `Modal`, `CustomizePicker`, `QuickActions`, `ContextMenu`, `Tab`, `Toast`, `ClaudeMdSuggestionModal`, `AccountMenu`, `AccountSwitchModal`, `TranscriptPruner`, `WhatsNew`.

> `ChatView.js` is 9,300 lines and `TerminalManager.js` 4,800 - by far the two largest files in the repo. Both have accumulated well past the point where they should be split; `src/renderer/services/markdown/` is the in-repo precedent for how to do it. Prefer adding new chat behaviour as a sibling module over growing `ChatView.js` further.

`ProjectBar` vs `ProjectList` is the `navigationMode` setting: a horizontal project tab bar, or the classic projects sidebar column.

### UI Panels (`src/renderer/ui/panels/`)

| Panel | Purpose |
|-------|---------|
| `SettingsPanel` | App settings, accent color, language, editor, startup, hooks |
| `GitChangesPanel` | Git status, staging, commit, push/pull, inline diff viewer, worktree switcher |
| `McpPanel` | MCP servers (start/stop, config, logs) |
| `PluginsPanel` | Claude Code plugins (browse, install, uninstall, update checks) |
| `SkillsAgentsPanel` | Skills + agents library with syntax-highlighted editor |
| `MarketplacePanel` | Skill marketplace search + install |
| `MemoryEditor` | Edit global / settings / project `CLAUDE.md` + Global Knowledge entries |
| `ShortcutsManager` | Customizable keyboard shortcuts |
| `RemotePanel` | Remote control (PIN, QR code, server status) |
| `ControlTowerPanel` | Real-time overview of all active Claude agents, remote interrupt, reply to AskUserQuestion |
| `ParallelTaskPanel` | Parallel run orchestration (start/cancel/merge/cleanup), per-task diff, terminal |
| `SessionReplayPanel` | Timeline replay of past sessions, video-scrubber, Q&A cards |
| `WorkflowPanel` | Visual node-based workflow editor (custom canvas engine), run history, AI assistant. Its "simple mode" tab is `TasksView` |
| `WorkflowMarketplacePanel` | Share / import workflows |
| `WorkflowHelpers.js` | Helpers for the workflow panel |
| `WorkspacePanel` | Workspace KB + advisor chat + concept links |
| `DatabasePanel` | Multi-driver data browser, SQL editor, Redis tree-view |
| `KanbanPanel` | Kanban board (tasks by column) |
| `CloudPanel` | Cloud sync with per-entity toggles, project upload/download, diff modal |
| `ConnectivityPanel` | Unified local remote + cloud connectivity status (Local / Cloud / claude.ai sub-tabs) |
| `ClaudeRemotePanel` | Connectivity → claude.ai: the conversations currently shared, with a way back to each tab. Its settings live in Settings → Claude → Remote Control |
| `FilesPanel` | The file explorer as a screen of its own: project tree on the left, selected file on the right, per-session diffs rendered like GitHub via `DiffRenderer`. Reuses `FileExplorer` rather than rewriting its 60 KB of behaviour, so it binds to the same fixed ids |
| `ArtifactsPanel` | Gallery of **published** artifacts for the current project - the local equivalent of Claude Desktop's artifact list. These come from the SDK's `Artifact` tool, so each has a real title, subtitle, emoji and shareable URL. Deliberately not the extracts the store also holds |
| `TasksView` | The "simple mode" tab of the workflow panel. A task is a workflow with `mode: 'simple'`; the user edits what / when / where and `src/shared/simple-task.js` compiles the cron expression, graph and steps. It writes the same workflow object the advanced editor writes, through the same `workflow.save` IPC |
| `ErrorLogPanel` | Error log viewer with level/domain filtering, pattern detection, AI diagnosis and export |

The dashboard has three sub-views, switched by `_dashViews` and rendered from `DashboardService`: **Overview** (the default), **Kanban** (delegated to `KanbanPanel`) and **Timeline**. The timeline is the only one that loads its own data, through `ProjectTimeline`; it caches the collected events for 30 s so changing the period or a filter chip redraws without six more round trips, and `invalidateCache()` drops that cache alongside the dashboard one.

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

**13 custom fields:** `agent-picker`, `claude-config`, `cron-picker`, `cwd-picker`, `db-config`, `loop-config`, `project-config`, `skill-picker`, `sql-editor`, `subworkflow-picker`, `time-config`, `trigger-config`, `variable-autocomplete`, plus `_registry.js`.

**12 trigger types**, one `*.trigger.js` each: `manual`, `cron`, `hook`, `webhook`, `on_workflow`, `chat_message`, `file_change`, `git_event`, `project_opened`, `terminal_exit_code`, `claude_session_start`, `claude_session_end`.

### Viewers (`src/renderer/viewers/`)

- `pdf-viewer.js` - PDF rendering via `pdfjs-dist`
- `three-viewer.js` - 3D model (.glb/.gltf/.obj) via `three`

### Internationalization (`src/renderer/i18n/locales/`)

- **Languages:** French (default), English (fallback), Spanish, Indonesian, Simplified Chinese (`fr.json`, `en.json`, `es.json`, `id.json`, `zh-CN.json`)
- **Keys:** 3641 per locale, all five in exact sync (enforced by `tests/i18n/i18n-coherence.test.js`)
- **Loading:** only `en.json` is bundled eagerly, as the guaranteed-loaded fallback for `t()`; the others are fetched by `initI18n()`
- **Detection:** auto-detect from `navigator.language`, `DEFAULT_LANGUAGE` is `fr`
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

## CSS Architecture (`styles/` - 30 files, ~57,000 lines)

### CSS Variables (`:root` in `base.css`)

```css
/* Colors */
--bg-primary: #0d0d0d;  --bg-secondary: #151515;  --bg-tertiary: #1a1a1a;
--bg-hover: #252525;    --bg-active: #2a2a2a;     --border-color: #2d2d2d;
--accent: #d97706;      --accent-hover: #f59e0b;   --accent-dim: rgba(217,119,6,0.15);
--accent-rgb: 217,119,6;   /* kept in sync by applyAccentColor() */
--success: #22c55e;  --warning: #f59e0b;  --danger: #ef4444;  --info: #3b82f6;  --purple: #a855f7;

/* Text ramp - every step clears WCAG AA (4.5:1) on bg-primary/secondary/tertiary.
   Do not darken these: secondary was lifted from #888 and muted from #555
   precisely to reach AA, and the ramp keeps one visible step per level. */
--text-primary: #e0e0e0;  --text-secondary: #a7a7a7;
--text-tertiary: #969696; --text-muted: #858585;

/* Premium model tier (Fable). Violet, never the accent, so it reads as
   "this one costs more" and not as "selected". */
--premium-color: #a78bfa;  --premium-text: #c4b5fd;  --premium-rgb: 167,139,250;

/* Layout */
--radius: 8px;  --radius-sm: 4px;  --sidebar-width: 200px;  --projects-panel-width: 350px;

/* Typography (rem-based) */
--font-2xs: 0.625rem;  --font-xs: 0.6875rem;  --font-sm: 0.8125rem;
--font-base: 0.875rem; --font-md: 1rem;       --font-lg: 1.125rem;
```

Every colour in the app is expected to come from these variables. There is **no theme
system**: no light mode, no `prefers-color-scheme`, no `data-theme`. `--accent` (and the
`--accent-rgb` kept in sync with it) is the only user-facing colour customisation.

### CSS Files (biggest first)

| File | Lines | Section |
|------|------:|---------|
| `workflow.css` | 7506 | Visual workflow editor (custom canvas engine) |
| `chat.css` | 5583 | Chat UI, messages, permissions, thinking, subagents |
| `projects.css` | 4627 | Project list, tree, project bar, drag-drop, customize |
| `git.css` | 4285 | Git panel, diff view, worktrees, commit graph |
| `settings.css` | 3166 | Settings forms |
| `database.css` | 3014 | DB panel, SQL editor, Redis tree |
| `dashboard.css` | 2695 | Stats cards, heatmap, health badges |
| `terminal.css` | 2484 | xterm, tabs, loading |
| `markdown-blocks.css` | 2381 | Custom markdown blocks |
| `modals.css` | 2348 | Modals |
| `parallel.css` | 2333 | Parallel tasks |
| `fivem.css` | 2164 | FiveM-specific |
| `skills.css` | 1625 | Skills + agents panel |
| `session-replay.css` | 1605 | Session Replay timeline |
| `layout.css` | 1489 | Sidebar, grid |
| `time-tracking.css` | 1444 | Time tracking charts |
| `memory.css` | 1147 | CLAUDE.md editor + global knowledge |
| `cloud.css` | 956 | Cloud sync |
| `control-tower.css` | 947 | Control Tower |
| `workspace.css` | 824 | Workspace KB |
| `mcp.css` | 816 | MCP management |
| `discord-theme.css` | 739 | Discord builder theme |
| `kanban.css` | 692 | Kanban board |
| `artifacts.css` | 554 | Artifact library |
| `files.css` | 450 | Files screen |
| `errorlog.css` | 430 | Error log panel |
| `xterm.css` | 285 | xterm vendor |
| `base.css` | 274 | Variables, fonts, reset |
| `diff.css` | 106 | DiffRenderer output |
| `index.css` | 29 | Entry point - @imports all of the above, bundled by esbuild |

`litegraph.css` is gone: the workflow editor no longer uses LiteGraph.

### Naming Convention

```css
.component-name { }            /* Base */
.component-name.state { }      /* State modifier (e.g. .project-item.active) */
.component-name[data-x] { }    /* Data attribute conditional */
.component-name:has(.child) {} /* Parent selector */
```

## Preload Bridge (`src/main/preload.js`)

Exposes API namespaces on `window.electron_api`:

`terminal` | `git` (69 methods) | `github` | `chat` | `claude` | `accounts` | `mcp` | `mcpRegistry` | `mcpTerminal` | `mcpTab` | `marketplace` | `plugins` | `dialog` | `explorer` | `window` | `app` | `notification` | `usage` | `project` | `hooks` | `updates` | `setupWizard` | `lifecycle` | `quickPicker` | `tray` | `fivem` | `webapp` | `api` | `python` | `minecraft` | `discord` | `discordRpc` | `remote` | `remoteControl` | `workspace` | `workflow` | `parallel` | `database` | `time` | `telemetry` | `cloud` | `knowledge` | `artifacts` | `chrome` | `errorLog` | `voice` | `preview` | `controlTower`

Also exposes `window.electron_nodeModules`: `path`, `fs` (sync + promises, guarded by a system-path blocklist in `preload.js`), `os.homedir()`, a small allowlist of `process.env` vars, and `__dirname`.

**`child_process` is deliberately NOT exposed.** Never add it: the renderer displays model-authored markdown, so a bridge to process spawning would turn any HTML injection into code execution.

## Data Storage

```
~/.claude-terminal/                    # App data directory
├── projects.json                      # Projects with folder hierarchy & quick actions
├── settings.json                      # User preferences (accent, language, editor, shortcuts, pinnedTabs, sidebarOrder)
├── timetracking.json                  # Time tracking data (v2 format)
├── marketplace.json                   # Installed skills manifest
├── session-names.json                 # Session display names
├── knowledge/
│   ├── index.json                     # Global knowledge entry metadata
│   └── entries/<slug>.md              # One markdown file per entry
├── session-pins.json                  # Pinned sessions
├── parallel-runs.json                 # Parallel task run history
├── accounts/                          # Snapshots of the CLI credential store, one per named account
├── artifacts/
│   ├── index.json                     # Artifact metadata (also written directly by the MCP tools)
│   └── <id>/                          # Artifact versions
├── terminals/output/<projectId>.log   # Rolling terminal output tail (TerminalOutputCapture)
├── workflows/
│   ├── definitions.json               # Workflow graphs (single-writer protocol, see _workflowStore.js)
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

OS credential store (via keytar)       # GitHub token, Groq API key
                                       # (Windows Credential Manager / macOS Keychain / Linux libsecret)
```

Secrets never go in `settings.json`. On macOS the Claude CLI keeps its own credentials in
the login Keychain rather than `~/.claude/.credentials.json`; `claudeCredentials.js` hides
that difference from `AccountManager`.

## Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `electron` | ^28.0.0 | Desktop framework (Chromium 120) |
| `@anthropic-ai/claude-agent-sdk` | ^0.3.260 | Claude Code streaming chat |
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
| `jest` + jsdom | ^29.7.0 | Unit tests |
| `eslint` + `@eslint/js` | ^10.10.0 | Flat-config lint over main / renderer / shared / MCP / scripts |
| `playwright` | ^1.58.2 | `_electron` driver for the E2E smoke test, plus marketing screenshots |
| `axe-core` | - | Accessibility audit (WebApp Live Preview) |
| `sharp` / `ffmpeg-static` | - | Asset + video processing for marketing scripts |

There is **no** LiteGraph dependency any more, and no TypeScript: the app is plain
CommonJS JavaScript with JSDoc types. `cloud/` and `hub-worker/` are separate packages
with their own `package.json` (the cloud relay is TypeScript, the hub is a Cloudflare
Worker); neither is bundled into the desktop app.

## Key Implementation Details

- **Context isolation is ON:** `contextIsolation: true` + `nodeIntegration: false` in all 5 windows, with the `electron_api` bridge exposed via `contextBridge`
- **CSP:** `index.html` sets `script-src 'self' 'unsafe-eval'` with **no** `'unsafe-inline'`. This is the app's most important control — it means HTML injected into the chat cannot execute script. Do not relax it.
- **HTML preview scheme:** ```` ```html ```` markdown blocks are served over a dedicated `ct-preview://` scheme, not a `blob:` URL. `blob:`, `data:` and `srcdoc` documents inherit the creating page's CSP, so a blob preview was either blocked outright or rendered with its inline scripts stripped. The custom scheme gives the preview its own origin and its own (permissive) CSP without touching the renderer's.
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
- **Remote control (local):** WS server with PIN auth, QR code, PWA in `remote-ui/`
- **Remote Control (claude.ai):** decided per conversation, never globally. `claudeRemoteControlEnabled` only says the feature may be used; a session reaches claude.ai when the user asks for it in that tab, via the footer button or the local `/remote-control` command (`enableForSession` / `disableForSession`). Nothing is backfilled: claude.ai joins from the moment it is enabled. Attaches the session to `@anthropic-ai/claude-agent-sdk/bridge` so it appears at claude.ai/code and in the Claude mobile app. The bridge export is ESM-only and `@alpha` — loaded through `src/main/utils/claudeBridge.js`, which resolves it out of `app.asar.unpacked` and feature-detects every function it uses. `claudeRemoteControlDrive` decides between a read-only mirror (`outboundOnly`) and full driving; `claudeRemoteControlTerminals` adds `--rc` to the CLI in terminal tabs. Honours the `disableRemoteControl` kill switch, read from Claude Code's own managed-settings file (`managedSettingsPaths()` in `src/main/utils/paths.js`) rather than from this app's user-writable settings.json, so a user cannot lift an org policy
- **Model, effort and permission mode are per conversation:** the chat footer's chip (model · effort, right) and mode picker (left, as Claude Desktop places it) change the current tab only. The stored `chatModel` / `effortLevel` / `executionMode` are the defaults a new tab starts from, moved only through each menu's "Use for new conversations" row — a pick never writes them, so the last choice in one tab cannot silently become every later tab's. The model menu lists models only: the CLI's `default` alias is read for the model it points at (`recommendedModelId`, surfaced as the catalog's `recommended`) and then dropped (`dropDefaultAlias`), so an unpinned tab shows that model **by name** instead of a "Default (recommended)" row that stood for whichever model the CLI favoured that week. `chatModel: null` still means "nothing pinned"; pinning always stores a concrete id. Modes are the SDK's (`default`, `acceptEdits`, `plan`, `bypassPermissions`, `auto`), mapped to the legacy `executionMode` spellings in `src/shared/permission-modes.js`; `ChatService.setPermissionMode` switches mid-session and moves the app-side auto-approval with it. Fable is a hand-curated premium tier (`PREMIUM_FAMILIES` in `src/shared/model-options.js`, hand-curated because the CLI catalog says nothing about it): violet chip and composer border, "Premium" badge in the menu, a tag on the tab, and a dismissible notice above the composer when a new tab inherits it. What the UI says about it is that the family draws on its own usage limit — the model-scoped `limits` entry the usage API returns beside `session` and `weekly_all` — and that this also counts toward overall usage; on a subscription it is not billed on top, so no string may say it is. `max` effort turns the effort segment warning-coloured. Every (re)start and every mid-session switch leaves a line in the transcript
- **Cloud sync:** self-hosted Docker relay, per-entity toggles, file watcher, conflict diff modal
- **Claude in Chrome:** opt-in (`chromeBridgeEnabled`). Adds the `claude-in-chrome` MCP server — 22 browser tools — to chat sessions by spawning the bundled SDK binary with `--claude-in-chrome-mcp`; Chrome reaches it through a native messaging host manifest whose name (`com.anthropic.claude_code_browser_extension`) is fixed by the extension and therefore shared with Claude Code, so an existing working manifest is adopted, never overwritten
- **Parallel tasks:** git worktrees per sub-task, AI merge agent, persisted run state
- **Workflows:** custom canvas editor (no LiteGraph), 31 nodes / 12 trigger types, AI assistant for graph editing, webhook/cron/hook/file/git/session triggers. A workflow with `mode: 'simple'` is a "task": `src/shared/simple-task.js` compiles it into the same graph the advanced editor produces, so both paths write one object through one `workflow.save` IPC
- **Workspace:** cross-project KB with advisor chat, concept links, `@workspace` mention
- **Multiple accounts:** `AccountManager` snapshots the CLI's live credential store per named account and swaps it on demand; a project can be bound to one. Login itself is never reimplemented - the user runs `claude /login` once and the result is captured. Switching mid-conversation resumes with the CLI session id, and MCP tokens are deliberately left alone
- **Voice:** the renderer captures the mic and sends raw PCM to main; the Groq key stays in the OS credential store and never crosses to the renderer. Transcription output goes to the screen only, routed to the focused tab
- **Artifacts:** `src/shared/artifact-store.js` is shared verbatim with the MCP server process, which writes `index.json` directly. Since an out-of-process writer cannot reach a BrowserWindow, `ArtifactService` polls the file and broadcasts `artifacts-changed`
- **Error log:** every `console.error`/`console.warn` in main is mirrored into `ErrorLogService`, but as `warning`. `critical` is reserved for `uncaughtException` and `unhandledRejection`, so the panel's critical count means "the app broke", not "something logged"
- **Idle animation pausing:** all infinite CSS animations stop while the window is unfocused. On a large transcript a single composited spinner measured ~30% of a core, and every perpetual animation in the app is a "still working" indicator, so freezing them costs the user nothing
- **Security:** `dompurify` for all user-rendered markdown; never inject untrusted HTML into chat/dashboard

## Testing

```bash
npm test                    # Run all 127 unit test files (jsdom environment)
npm run test:watch          # Watch mode
npm run check:docs          # Verify this file still matches the tree
npm run lint                # ESLint (see below)
npm run test:e2e            # Playwright smoke test against the real Electron app
```

### Unit tests (Jest)

- **Framework:** Jest with jsdom, 136 test files
- **Setup:** `tests/setup.js` mocks `window.electron_nodeModules`, `window.electron_api`, `requestAnimationFrame`
- **Pattern:** `**/tests/**/*.test.js`
- **Directories:**
  - `core/` - BaseComponent, BasePanel, ApiProvider, ServiceContainer
  - `events/` - hook session routing
  - `features/` - shortcuts, control tower grid, files dock, setup wizard, tab focus, ui_navigate
  - `i18n/` - i18n, coherence across the 5 locales, unused/missing key usage
  - `integration/` - state persistence
  - `ipc/` - accounts usage, claude, hooks, project, usage, workflow save
  - `remote-ui/` - hierarchy
  - `security/` - security tests
  - `services/` - ChatService, AccountManager, ArtifactService, DatabaseService, DashboardService, DiffRenderer, HooksService, KnowledgeService, MarkdownRenderer, ModelCatalogService, RemoteServer, RemoteControlService, UsageService, VoiceService, WorkflowRunner and the workflow engine suite
  - `shared/` - context usage, cron, model options, permission modes, simple-task
  - `smoke/` - every module parses and loads
  - `state/` - State plus each state module
  - `ui/` - chat account switch, chat limit error, task widget, tasks drawer, ClaudeRemotePanel, navigation mode, kanban live refresh
  - `utils/` - attachments, color, commit messages, drop paths, file icons, file lock, format, frontmatter, git, http cache, session search, shell, syntax highlight, tool registry

### Lint (`eslint.config.js`)

Flat config, ESLint 10. Two things it deliberately does not do:

- **No formatting rules, and no Prettier.** The codebase is hand-formatted and
  consistently so; a reformatting pass would rewrite most of ~144k lines and bury
  every `git blame` that currently explains why something is the way it is.
- **Nothing that would need a mass `eslint-disable` sweep to go green.** A lint run
  that is red on arrival gets ignored, and then it guards nothing. Rules that fire
  widely on existing working code are `warn`; `npm run lint` fails on errors only.
  `require-await` is off outright: async-without-await is a convention here (the MCP
  tool-module contract, the uniformly-async IPC handlers, test mocks mirroring async
  signatures), so its 497 hits were all non-actionable.

What it is for is the third thing - the architectural boundaries this file describes
in prose, which until now were enforced by nobody:

| Boundary | Rule |
|----------|------|
| The renderer never gets `child_process`, `fs`, `net`, `electron`... | `no-restricted-syntax` on the `require()` call |
| The renderer never reaches into `src/main/` | same |
| The main process never requires `src/renderer/` | same |
| No `document` / `navigator` / `localStorage` in main | `no-restricted-globals` |

`no-restricted-imports` only understands ESM `import`, and the `no-restricted-modules`
rule that covered `require()` was removed in ESLint 7, so these are written as esquery
selectors over the `require()` call shape instead.

These are not hypothetical. The renderer/electron rule was added after five click
handlers were found calling `require('electron').shell.openExternal(...)` from renderer
code, which throws under `contextIsolation` - so none of those buttons had ever worked.
If one of these rules fires, the fix is a new IPC handler, not an `eslint-disable`.

Two documented exceptions, both real:

- `src/main/workflow-nodes/**` may use `document` and `window`. Each `*.node.js` exports
  both an `execute()` that runs in main and that node's config-panel UI;
  `workflow.ipc.js` ships the UI half to the renderer as source text (`fn.toString()`)
  where it is rehydrated with `new Function()`. Those functions only ever run in the
  renderer.
- `src/renderer/viewers/**` is ESM, not CommonJS: both viewers are built as separate
  bundles and pulled in with a dynamic `import()`.

### E2E smoke (`tests/e2e/smoke.js`)

All 127 Jest suites run in jsdom against a mocked `window.electron_api`, so nothing
in the repository asserts that the application actually starts. Every regression of
the shape "the window opens but panel X throws on first render" has had to be found
by a human opening the app. This covers that gap and only that.

It uses Playwright's `_electron` driver (no `@playwright/test`; it is a plain Node
script, run with `node tests/e2e/smoke.js`) and asserts three things:

1. The window opens and the custom titlebar renders.
2. Every sidebar tab opens without a renderer console error or uncaught page error,
   attributed to the tab that produced it.
3. `ErrorLogService` recorded no `critical` entry - which, per that service, means no
   `uncaughtException` and no `unhandledRejection` in the main process.

Isolation is the fiddly part, and there are three separate reasons for it:

- `HOME` / `USERPROFILE` point at a throwaway directory, so `os.homedir()` relocates
  **both** `~/.claude-terminal` and `~/.claude`, in the main process and the renderer
  alike. That is why the env is overridden rather than teaching `paths.js` a
  `CT_DATA_DIR`: only one of those two directories is this app's data.
- `--user-data-dir` gives Electron its own profile, which also scopes
  `app.requestSingleInstanceLock()`. Without it the launch would hit the developer's
  already-running instance and quit immediately.
- `settings.json` is seeded with `setupCompleted: true`, because a genuinely
  first-launch profile opens the setup wizard instead of the main window. Networked
  and background features are seeded off, so a failure means a panel threw rather
  than a relay being unreachable.

Kept out of `npm test`: it needs a display (`xvfb-run` on Linux CI) and a built
renderer bundle. Running it locally also needs the native modules built against
Electron's ABI (`npm run postinstall`), which on Windows means a Python and MSVC
toolchain for `node-pty`.

## CI/CD

**GitHub Actions (`.github/workflows/`):**

- `ci.yml` - triggers on push to `main` and PRs. Three jobs:
  - `lint` - Ubuntu only, `npm run check:docs` then `npm run lint`, installed with `--ignore-scripts` so no native rebuild is needed. Fast, fails first.
  - `test` - matrix Node 18 + 20 on windows-latest, ubuntu-latest, macos-latest: `npm ci`, `build:renderer`, `test`.
  - `e2e` - Ubuntu only, under `xvfb-run`, and **blocking**. It shipped `continue-on-error` for one commit; in that window it failed twice while the run still reported `success`, so nobody saw it. A test that cannot fail the build reports nothing. Flakiness under Xvfb is worth seeing and fixing rather than muting.
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

**Available tool modules (23):**

Files prefixed with `_` are shared helpers, not tool modules — the loader ignores them because they export no `tools`/`handle`. `_workflowStore.js` owns the single definitions.json writer protocol (cross-process lock, atomic write, reload signal) used by both `workflow.js` and `automation.js`.

| Module | Key tools |
|--------|-----------|
| `projects.js` | `project_list`, `project_info`, `project_todos` |
| `timetracking.js` | `time_today`, `time_week`, `time_summary`, `time_project` |
| `sessions.js` | `session_list`, `session_replay`, `session_search` (cross-project keyword search over past conversations, index-free), `session_recap` (compact "where are we at" digest) |
| `database.js` | `db_query`, `db_list_tables`, `db_describe_table`, `db_schema_full`, `db_stats`, `db_export` |
| `webapp.js` | `webapp_stack`, `webapp_scripts`, `webapp_start`, `webapp_stop` |
| `fivem.js` | `fivem_command`, `fivem_list_resources`, `fivem_read_manifest`, `fivem_resource_files`, `fivem_server_cfg` |
| `discord.js` | `discord_bot_status`, `discord_list_commands` |
| `workflow.js` | Create/list/run/cancel/diagnose + run logs + variables (graph workflows; node tools refuse `mode: 'simple'`) |
| `automation.js` | `automation_list`, `automation_get`, `automation_create`, `automation_update`, `automation_enable`, `automation_delete` — compiles via `src/shared/simple-task.js` |
| `parallel.js` | `parallel_list_runs`, `parallel_run_detail`, `parallel_start_run`, `parallel_cancel_run`, `parallel_cleanup_run`, `parallel_merge_run` |
| `workspace.js` | `workspace_list`, `workspace_info`, `workspace_read_doc`, `workspace_write_doc`, `workspace_search`, `workspace_add_link` |
| `knowledge.js` | `knowledge_list`, `knowledge_get`, `knowledge_search`, `knowledge_write`, `knowledge_delete` — cross-project facts, available in every session |
| `control-tower.js` | `control_tower_agents`, `control_tower_interrupt` |
| `kanban.js` | Kanban columns + tasks (add / move / update / filter / stats) |
| `terminal.js` | `terminal_create`, `terminal_list`, `terminal_send_command`, `terminal_read_output`, `terminal_close` |
| `tabs.js` | Tab orchestration with permission control |
| `sidebar.js` | `ui_navigate` (switch the displayed panel, live via the `tabs/triggers` pipeline), `ui_state` (read back which panel is showing), `sidebar_get_pinned`, `sidebar_set_pinned` |
| `marketplace.js` | Skill marketplace tools |
| `plugins.js` | Plugin install / list / catalog |
| `settings.js` | `settings_get`, `settings_set` |
| `usage.js` | `usage_get`, `usage_refresh` |
| `artifacts.js` | `artifact_list`, `artifact_get`, `artifact_search`, `artifact_versions`, `artifact_stats`, `artifact_delete` — reads the same `src/shared/artifact-store.js` the app uses, hence the poll-for-out-of-process-writes in `ArtifactService` |
| `errorlog.js` | `errorlog_entries`, `errorlog_stats`, `errorlog_patterns`, `errorlog_export`, `errorlog_clear` |

## Conventions

- **Commits:** `feat(scope): description` in English, imperative mood
- **IPC pattern:** Service (main) -> IPC handler -> Preload bridge -> Renderer service
- **Dashboard sections:** `buildXxxHtml()` in `DashboardService.js`
- **CSS:** `.component-name.state` pattern, CSS variables, 30 modular files in `styles/`. No colour literals outside `base.css` - there is no theme system yet, and every hard-coded hex is one more thing to migrate when there is one
- **i18n:** add keys to all five locales (`en`, `fr`, `es`, `id`, `zh-CN`) - `tests/i18n/i18n-coherence.test.js` fails otherwise; use `t('dot.path')`. Main-process error messages stay in English.
- **State updates:** `state.set()` / `state.setProp()`, subscribe with `state.subscribe()`
- **File I/O:** atomic writes for user data (temp + rename), `.bak` backup
- **Project types:** extend `base-type.js`, register in `registry.js`, provide service + IPC + dashboard + i18n
- **Markdown:** prefer the rich custom blocks (tree, timeline, compare, metrics, api, tabs, discord-embed, workspace-doc, git-commit, workspace-links...) over plain bullet lists.
- **Security:** sanitize user-supplied markdown with `dompurify`; never inject untrusted HTML into chat or dashboard panels.
- **Lint:** `npm run lint` before pushing. The boundary rules encode the main/renderer split described above - if one fires, the fix is a new IPC handler, not an `eslint-disable`.
- **This file:** `npm run check:docs` verifies the counts and paths above against the actual tree. When you add an IPC file, a service, a panel, a node type or a locale, update the matching table in the same commit. A `CLAUDE.md` that sends the reader to a directory that no longer exists is worse than no `CLAUDE.md`.
