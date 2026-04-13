<p align="center">
  <img src="banner-readme.png" alt="Claude Terminal" width="100%" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/downloads/Sterll/claude-terminal/total?color=d97706&label=downloads" alt="Downloads" />
  <img src="https://img.shields.io/badge/version-1.2.5-orange" alt="Version" />
  <img src="https://img.shields.io/badge/platform-Windows%20|%20macOS%20|%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-green" alt="License" />
  <img src="https://img.shields.io/badge/electron-28-purple" alt="Electron" />
  <img src="https://img.shields.io/github/actions/workflow/status/Sterll/claude-terminal/ci.yml?branch=main&label=CI" alt="CI Status" />
  <img src="https://img.shields.io/github/contributors/Sterll/claude-terminal" alt="Contributors" />
  <img
    src="https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Sterll/ec1241ea62520261790ef5a411b4b212/raw/i18n_fr.json"
    alt="i18n French"
  />
  <img
    src="https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Sterll/ec1241ea62520261790ef5a411b4b212/raw/i18n_es.json"
    alt="i18n Spanish"
  />
</p>

<p align="center">
  A cross-platform desktop application for managing
  <a href="https://github.com/anthropics/claude-code">Claude Code</a>
  projects with an integrated terminal environment, git workflows, plugin management,
  and more.
</p>

<p align="center">
  <a href="https://claudeterminal.dev">Website</a> &bull;
  <a href="https://github.com/Sterll/claude-terminal/releases">Download</a> &bull;
  <a href="https://x.com/ClaudeTerminal_">Twitter</a> &bull;
  <a href="https://buymeacoffee.com/claudeterminal">Buy Me a Coffee</a>
</p>

<p align="center">
  <a
    href="https://www.producthunt.com/products/claude-terminal?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-claude-terminal"
    target="_blank"
    rel="noopener noreferrer"
  ><img
    alt="Claude Terminal - The missing desktop app for Claude Code developers | Product Hunt"
    width="250"
    height="54"
    src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1089096&amp;theme=light&amp;t=1772614696412"
  ></a>
</p>

<p align="center">
  <img
    src="https://img.shields.io/github/languages/top/Sterll/claude-terminal?color=7c3aed&amp;label=Top%20language"
    alt="Top language"
  />
  <img
    src="https://img.shields.io/github/languages/count/Sterll/claude-terminal?color=2563eb&amp;label=Languages"
    alt="Languages count"
  />
  <img
    src="https://img.shields.io/github/languages/code-size/Sterll/claude-terminal?color=0f766e&amp;label=Code%20size"
    alt="Code size"
  />
</p>

---

## 📊 Project Health

### Contributors

<a href="https://github.com/Sterll/claude-terminal/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Sterll/claude-terminal" alt="Contributors" />
</a>

### Activity

[![Commit activity](https://img.shields.io/github/commit-activity/m/Sterll/claude-terminal?label=commits%2Fmonth)](https://github.com/Sterll/claude-terminal/graphs/commit-activity)
[![Last commit](https://img.shields.io/github/last-commit/Sterll/claude-terminal)](https://github.com/Sterll/claude-terminal/commits/main)
[![Issues](https://img.shields.io/github/issues/Sterll/claude-terminal)](https://github.com/Sterll/claude-terminal/issues)
[![Pull Requests](https://img.shields.io/github/issues-pr/Sterll/claude-terminal)](https://github.com/Sterll/claude-terminal/pulls)

### Internationalization (i18n)

| Language | Coverage | Keys |
| --- | --- | --- |
| 🇺🇸 English (base) | ![100%][i18n-en-badge] | ~800 / ~800 |
| 🇫🇷 French | ![i18n fr][i18n-fr-badge] | ~800 / ~800 |
| 🇪🇸 Spanish | ![i18n es][i18n-es-badge] | ~800 / ~800 |

> Coverage badges are updated automatically on every push to locale files.
> See [`.github/i18n-coverage.md`](.github/i18n-coverage.md) for details and
> instructions on how to add a new language.

[i18n-en-badge]: https://img.shields.io/badge/i18n-100%25-brightgreen
[i18n-fr-badge]: https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Sterll/ec1241ea62520261790ef5a411b4b212/raw/i18n_fr.json
[i18n-es-badge]: https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Sterll/ec1241ea62520261790ef5a411b4b212/raw/i18n_es.json

---

## Table of Contents

- [Installation](#installation)
- [Features](#features)
- [Usage](#usage)
- [Building](#building)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Architecture](#architecture)
- [Contributing](#contributing)

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code](https://github.com/anthropics/claude-code) installed globally
- **Windows** 10 or 11
- **macOS** 12+ (Intel or Apple Silicon)
- **Linux** Ubuntu 22.04+, Fedora 38+, or equivalent
  - AppImage requires `libfuse2` on Ubuntu 24.04+: `sudo apt install libfuse2`
  - GitHub token storage requires `libsecret`: `sudo apt install libsecret-1-dev gnome-keyring`

## Installation

Download the latest installer from [Releases](https://github.com/Sterll/claude-terminal/releases).

> [!IMPORTANT]
> **macOS users:** If you see *"Claude Terminal is damaged and can't be opened"*, run this in Terminal:
> ```bash
> xattr -cr /Applications/Claude\ Terminal.app
> ```
> This is needed because the app is not code-signed yet. Alternatively, right-click the app → Open.

Or build from source:

```bash
git clone https://github.com/Sterll/claude-terminal.git
cd claude-terminal
npm install
```

---

## Features

### Chat UI (Claude Agent SDK)
- Built-in chat interface powered by the Claude Agent SDK with streaming responses
- **Rich markdown rendering**: mermaid diagrams, KaTeX math, syntax-highlighted code, file trees, kanban boards, diff blocks, HTML previews, and more
- **Permission cards**: Allow, Always Allow, or Deny tool use requests
- **Plan mode**: review and approve/reject agent plans before execution
- **Thinking blocks**: expandable sections showing Claude's reasoning
- **Tool cards**: collapsible cards showing tool execution with formatted details
- **Subagent visualization**: nested task tracking for spawned agents
- **Todo widget**: persistent task list above the input, auto-dismisses on completion
- **Image attachments**: paste, drag-drop, or pick PNG/JPEG/GIF/WebP images (up to 20MB)
- **Slash commands**: auto-completing commands (/compact, /clear, /help, custom skills)
- **Cost tracking**: model name, token count, and USD cost in the status bar
- **1M context window**: extended context for larger codebases (API mode only)
- **Dynamic model and effort switching**: change model (Sonnet, Opus, Haiku) and effort level (low, medium, high) mid-conversation without starting a new session
- **Pin conversations**: keep important sessions at the top of the list
- **Fork sessions**: branch from any message to explore alternative paths
- **Follow-up suggestions**: context-aware suggestion chips appear after Claude responds to help guide the conversation
- **Session recaps**: automatic AI-generated summaries of completed sessions
- Type @project to attach README.md and file tree from any project as context
- Type **@tab** to share your current terminal session or **@conversation** to reference another chat thread
- Type **@context** to inject a context pack or **@prompt** to insert a saved prompt template directly into your message
- **Prompt enhancement**: one-click AI rewrite of your message using Haiku for clearer instructions before sending
- Interrupt streaming mid-turn, auto-generated tab names via haiku model
- Compacting indicator shown during conversation compaction so you know when context is being compressed

### Terminals
- Multiple Claude Code terminals per project with tabbed interface
- GPU-accelerated rendering via xterm.js + WebGL (DOM fallback)
- Switch between terminal and chat mode per tab
- Tab drag-and-drop reordering, renaming, desktop notifications
- Filter terminals by project
- Adaptive ready detection with spinner status

### Project Management
- Organize projects in nested folders with drag-and-drop
- Customize each project with colors and emoji icons
- Quick Actions toolbar: configurable one-click commands per project (build, test, deploy, custom scripts...)
- Built-in file explorer with tree view, multi-select, search, git status indicators, and inline rename; right-click any file to attach it as context in the current chat
- Modular project type system (standard, FiveM, webapp, Python, API, Minecraft)
- Per-project settings modal

### Git Integration
- **Branches**: switch, create, delete with tree view of local/remote branches
- **Sync**: pull (rebase), push, merge with conflict detection and resolution
- **Changes panel**: view staged/unstaged/untracked files, stage/unstage and commit
- **Commit history**: IntelliJ-style commit graph with SVG rendering, branch/author filtering, infinite scroll
- **Cherry-pick & revert**: advanced commit operations from history
- **Worktree management**: create, switch, and delete Git worktrees with quick-switch badge in the toolbar
- **Stash management**: save, apply, pop, and inspect stashes
- **History search**: full-text search across commit history
- **Discard changes**: quickly discard unstaged edits per file
- **Amend commits**: edit the last commit message or staged content before pushing
- **AI commit messages**: auto-generate conventional commit messages via GitHub Models API
- **Pull Requests**: create and view PRs directly from the app

### GitHub Integration
- OAuth Device Flow authentication (secure, no token copy-paste)
- **GitHub Enterprise support**: connect to self-hosted GitHub Enterprise instances
- **Repository search in clone wizard**: search GitHub repos by name without leaving the app
- **CI/CD status pill**: live inline status of the latest workflow run shown directly in the terminal header bar, with a Fix-it button to jump straight to a failing step
- View CI/CD workflow runs per repository
- View, create, and review pull requests from the app; multi-forge support (GitHub, GitLab)
- Token stored securely via keytar (Windows Credential Manager, macOS Keychain, Linux libsecret)

### Control Tower
- Real-time overview of all active Claude agents across every project
- See what each agent is doing (tools it's running, current status, last activity)
- Interrupt any running session directly from the panel
- Reply to AskUserQuestion prompts without switching to the chat tab
- MCP tools for agent monitoring and remote interrupt

### Parallel Tasks
- Decompose a feature into parallel subtasks and run them simultaneously as separate Claude agents
- Each task runs in its own Git worktree and branch, keeping work isolated
- Auto mode lets Claude decide the optimal number of parallel tasks
- Collapsible task cards with per-task diff viewer and terminal access
- Auto-merge agent: Claude reviews and merges completed branches into your main branch
- Full run state persisted to disk and restored on app restart

### Session Replay
- Browse past Claude Code sessions and replay them step by step
- Timeline view shows all prompts, tool calls, and responses in chronological order
- Video-player-style scrubber to jump to any point in a session
- Q&A cards highlight question-and-answer exchanges for easy review

### Dashboard
- Per-project overview: current branch, commits ahead/behind, recent commits, contributors
- Code statistics: lines of code by language, file count, commit count
- Active terminals count
- Claude API usage monitoring with auto-refresh

### Time Tracking
- Automatic session detection per project (15-min idle timeout, sleep/wake detection)
- Separate lightweight storage (`timetracking.json`) with monthly archives
- View by period: today, this week, this month, custom range
- Stats: daily average, longest streak, evolution charts, recent sessions
- Midnight rollover and periodic checkpoints

### Hooks
- Integrates with Claude Code CLI hooks for real-time activity tracking
- One-click install into `~/.claude/settings.json` (non-destructive, preserves user hooks)
- 15 hook types: PreToolUse, PostToolUse, Notification, SessionStart, Stop, and more
- Event bus with normalized events for session, tool, and subagent tracking
- Fallback terminal scraping when hooks are unavailable

### Plugins
- Browse and discover plugins from configured marketplaces
- Install plugins directly from the app (via Claude CLI)
- Add community marketplaces by GitHub URL
- Category filtering and search
- View plugin details and README

### Skill Marketplace
- Search and browse available skills
- One-click install and uninstall
- **Update checking**: see which installed skills and plugins have new versions available
- View skill README and details
- Local cache for fast browsing

### Library
- Manage reusable **context packs** (documents, snippets, file contents) and **prompt templates**
- Inject context packs or prompt templates directly into the chat via @context and @prompt mentions
- Insert prompt templates into any terminal with one click from the toolbar
- Generate skills and agents in the background using the Agent SDK

### Skills & Agents
- Browse and manage Claude Code skills and agents
- View SKILL.md and agent configuration files
- **Syntax-highlighted editor**: edit skill and agent files with line numbers and full highlight.js code highlighting
- Load skills from `~/.claude/skills`, plugins, and bundled resources

### MCP Servers
- Configure, start and stop MCP servers
- Environment variable configuration
- **MCP Registry**: browse and search the public MCP server registry

### Sessions
- View Claude Code sessions per project
- Browse session history with timestamps and metadata
- Pin sessions to the top and rename them inline from the resume dialog
- Modernized session resume modal with search and pinned sessions

### Memory
- Edit global, settings and project-specific CLAUDE.md files
- Template insertion for common patterns

### Settings
- Accent color theming (preset palettes + custom hex)
- Per-agent and per-tool color customization for chat tool cards
- Language: English, French, and Spanish with auto-detection
- Editor integration: VS Code, Cursor, WebStorm, IntelliJ IDEA
- Customizable keyboard shortcuts
- Desktop notification preferences
- Close behavior (ask, minimize to tray, or quit)
- Launch at startup toggle
- Auto-updates with background download and install banner

### Workflow Automation
- Visual node-based workflow editor with custom canvas engine (Blueprint-style)
- 15+ node types: shell, git, HTTP, Claude (prompt/agent/skill), condition, loop, transform, switch, subworkflow, database, file, project, time, variable, trigger
- Typed data pins with visual data flow between nodes
- AI assistant panel for real-time graph editing and node creation
- Undo/redo, copy/paste, snap-to-grid, minimap, comments
- Run history with live loop progress and step output inspection
- Workflow community hub for sharing and importing workflows
- Cron, hook, and webhook triggers
- MCP tools for full workflow control from Claude Code

### Connectivity (Remote & Cloud)
- Unified **Connectivity tab** combining local remote access and cloud sync in one place
- Self-hosted Docker relay server for remote project access
- Project upload and auto-sync with file watcher and conflict resolution
- **Per-entity sync toggles**: choose exactly which data syncs (projects, settings, skills, agents, MCP configs, keybindings, memory, hooks, archives)
- **Session resume from cloud**: pick up any session from another machine
- **Cross-machine notifications**: get notified on your desktop when a cloud session finishes
- Headless Claude sessions running in the cloud
- Diff modal for local vs cloud file comparison
- User profiles and session management
- Automated install script with Docker, reverse proxy, and SSL setup

### Database Panel
- Multi-driver support: SQLite, MySQL, PostgreSQL, MongoDB
- **Redis browser**: tree-view key explorer with type-aware value inspection
- Split-pane data browser with inline editing
- SQL query editor with syntax highlighting, templates, and multi-statement execution
- Insert/delete rows, search filter
- Custom database picker for quick connection switching
- Connection pooling with idle eviction

### Workspace
- Project-level knowledge base for storing persistent context, documentation snippets, and notes
- **Advisor chat**: ask questions about your workspace and get answers based on your knowledge base content
- **@workspace mention**: type @workspace in chat to inject your workspace knowledge base as context
- MCP tools for reading and writing workspace content from Claude Code

### MCP Server (claude-terminal)
- Unified MCP server exposing all Claude Terminal features to Claude Code
- Workflow tools: create, edit, trigger, diagnose, variables, run logs
- Database tools: query, export, full schema, stats
- Project and time tracking tools
- Quick action triggers with polling
- FiveM and WebApp project tools

### WebApp Preview
- Live preview with Chromium webview (replaces iframe)
- Visual feedback with multi-pin annotations per page
- Responsive breakpoint checker
- Auto-detect visual problems scanner
- Ruler spacing measurement tool
- Accessibility audit panel with axe-core

### Remote Control
- Mobile PWA for remote control from phone or browser
- Cloud relay for access anywhere (via self-hosted server)
- Real-time session monitoring, chat interaction, and project switching
- 6-digit PIN authentication with QR code

### Sidebar Customization
- Drag and drop sidebar tabs to reorder them to your workflow
- Pin frequently-used tabs; less-used tabs collapse into a More overflow menu
- Customize via a modal or directly by dragging

### Command Palette
- Unified command palette (Ctrl+P) with fuzzy search across projects, commands, and quick actions
- Smart launcher with shimmer skeleton loading and match highlighting
- Navigate to any panel or trigger any action without touching the mouse

### Auto CLAUDE.md Updates
- After a session ends, Claude analyzes the conversation and proposes relevant additions to your project's CLAUDE.md
- Review and accept suggestions in a diff-style modal before they're applied

### Other
- **Session restore**: save and restore full workspace sessions across restarts
- **File viewers**: integrated .md viewer, PDF viewer, and 3D model viewer (.glb, .gltf, .obj) in the terminal panel
- **Dashboard insights**: project health badges and commit heatmap
- **File explorer watcher**: automatic tree updates on filesystem changes
- **Tab context menus**: right-click on any tab for quick actions
- **Window state persistence**: remember position, size, and maximized state
- First-launch setup wizard with optional hooks installation
- System tray integration with accent-colored icon
- Custom toast notifications with stacking, click-through transparency, and action buttons
- Global shortcuts (`Ctrl+Shift+P` / `Cmd+Shift+P` quick picker, `Ctrl+Shift+T` / `Cmd+Shift+T` new terminal)
- Single instance lock
- Custom NSIS installer with branded images (Windows), DMG (macOS), AppImage (Linux), Snapcraft, Flatpak
- FiveM server management (launch, integrated console, resource scanning, resource creator wizard)
- Minecraft project type with Java plugin generator and platform-aware launch scripts
- Web app management with framework auto-detection and scaffold templates
- Python project detection (version, venv, dependencies, entry point)
- API project type with integrated route tester, variables, and console
- **Discord bot project type**: visual embed and component builder with live preview

## Usage

```bash
# Install dependencies once
npm install

# Build renderer and run the app
npm start

# Run with DevTools open
npm run start:dev

# Build renderer in watch mode (for development)
npm run watch
```

> [!TIP]
> If you modify files under `src/renderer/`, `src/project-types/`, or `renderer.js`, run `npm run build:renderer` before packaging or opening a PR.

## Building

```bash
# Build for current platform
npm run build

# Build for a specific platform
npm run build:win     # Windows (NSIS installer)
npm run build:mac     # macOS (DMG)
npm run build:linux   # Linux (AppImage)
```

The installer will be generated in the `build/` directory.

## Testing

```bash
# Run the test suite
npm test

# Watch tests during development
npm run test:watch
```

---

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+P` | Quick project picker (global) |
| `Ctrl+Shift+T` | New terminal in current project (global) |
| `Ctrl+Shift+E` | Sessions panel |
| `Ctrl+T` | Create terminal |
| `Ctrl+W` | Close terminal |
| `Ctrl+P` | Quick picker |
| `Ctrl+,` | Settings |
| `Ctrl+←` / `Ctrl+→` | Switch terminal (left/right) |
| `Ctrl+↑` / `Ctrl+↓` | Switch project (up/down) |
| `Escape` | Close dialogs |

Shortcuts are customizable in Settings.

---

## Architecture

```
claude-terminal/
├── main.js                    # Electron entry point
├── renderer.js                # Main renderer logic (bundled to dist/)
├── index.html                 # Main window UI
├── notification.html          # Custom toast notification window
├── quick-picker.html          # Quick picker window
├── setup-wizard.html          # First-launch wizard
├── styles/                    # Modular application styles
├── src/
│   ├── main/                  # Main process
│   │   ├── index.js           # Bootstrap & lifecycle
│   │   ├── preload.js         # Context bridge API
│   │   ├── ipc/               # IPC handlers
│   │   │   ├── terminal.ipc.js
│   │   │   ├── git.ipc.js
│   │   │   ├── github.ipc.js
│   │   │   ├── chat.ipc.js       # Chat UI / Agent SDK handlers
│   │   │   ├── claude.ipc.js
│   │   │   ├── usage.ipc.js
│   │   │   ├── mcp.ipc.js
│   │   │   ├── mcpRegistry.ipc.js
│   │   │   ├── plugin.ipc.js
│   │   │   ├── marketplace.ipc.js
│   │   │   ├── project.ipc.js
│   │   │   └── dialog.ipc.js
│   │   ├── services/
│   │   │   ├── TerminalService.js
│   │   │   ├── ChatService.js        # Claude Agent SDK wrapper
│   │   │   ├── PluginService.js
│   │   │   ├── MarketplaceService.js
│   │   │   ├── GitHubAuthService.js
│   │   │   ├── UsageService.js
│   │   │   ├── McpService.js
│   │   │   ├── McpRegistryService.js
│   │   │   ├── HookEventServer.js    # HTTP server for hook events
│   │   │   ├── FivemService.js
│   │   │   └── UpdaterService.js
│   │   ├── windows/
│   │   │   ├── MainWindow.js
│   │   │   ├── NotificationWindow.js  # Custom toast notifications
│   │   │   ├── QuickPickerWindow.js
│   │   │   ├── SetupWizardWindow.js
│   │   │   └── TrayManager.js
│   │   └── utils/
│   │       ├── paths.js
│   │       ├── git.js
│   │       └── commitMessageGenerator.js
│   ├── renderer/              # Renderer process
│   │   ├── services/
│   │   │   ├── ProjectService.js
│   │   │   ├── TerminalService.js
│   │   │   ├── SettingsService.js
│   │   │   ├── DashboardService.js
│   │   │   ├── GitTabService.js
│   │   │   ├── TimeTrackingDashboard.js
│   │   │   ├── ArchiveService.js      # Monthly time-tracking archives
│   │   │   ├── SkillService.js
│   │   │   ├── AgentService.js
│   │   │   └── McpService.js
│   │   ├── state/
│   │   │   ├── State.js           # Base observable class
│   │   │   ├── projects.state.js
│   │   │   ├── terminals.state.js
│   │   │   ├── settings.state.js
│   │   │   ├── git.state.js
│   │   │   ├── mcp.state.js
│   │   │   └── timeTracking.state.js
│   │   ├── ui/
│   │   │   ├── components/
│   │   │   │   ├── ProjectList.js
│   │   │   │   ├── TerminalManager.js
│   │   │   │   ├── ChatView.js        # Chat UI component
│   │   │   │   ├── FileExplorer.js
│   │   │   │   ├── Modal.js
│   │   │   │   ├── Toast.js
│   │   │   │   ├── ContextMenu.js
│   │   │   │   ├── Tab.js
│   │   │   │   ├── CustomizePicker.js
│   │   │   │   └── QuickActions.js
│   │   │   └── themes/
│   │   │       └── terminal-themes.js
│   │   ├── features/
│   │   │   ├── QuickPicker.js
│   │   │   ├── KeyboardShortcuts.js
│   │   │   └── DragDrop.js
│   │   ├── events/
│   │   │   ├── ClaudeEventBus.js      # Unified event system
│   │   │   ├── HooksProvider.js       # Hook events normalization
│   │   │   └── ScrapingProvider.js    # Fallback terminal scraping
│   │   ├── i18n/
│   │   │   └── locales/
│   │   │       ├── en.json
│   │   │       └── fr.json
│   │   └── utils/
│   │       ├── dom.js
│   │       ├── color.js
│   │       ├── format.js
│   │       ├── paths.js
│   │       ├── fileIcons.js
│   │       └── syntaxHighlight.js
│   └── project-types/         # Modular project type system
│       ├── registry.js        # Type registry & discovery
│       ├── base-type.js       # Base class for project types
│       ├── general/           # Standard project type
│       ├── fivem/             # FiveM server projects
│       │   ├── main/          # IPC & service
│       │   ├── renderer/      # Dashboard, state, terminal panel, wizard
│       │   └── i18n/          # en.json, fr.json, es.json
│       ├── webapp/            # Web app projects
│       │   ├── main/          # IPC & service
│       │   ├── renderer/      # Dashboard, state, terminal panel, wizard
│       │   └── i18n/          # en.json, fr.json, es.json
│       ├── python/            # Python projects (detection only)
│       │   ├── main/          # Detection service
│       │   ├── renderer/      # Dashboard, state, wizard
│       │   └── i18n/          # en.json, fr.json, es.json
│       ├── minecraft/          # Minecraft Java plugin projects
│       │   ├── main/          # Detection service, plugin generator
│       │   ├── renderer/      # Dashboard, state, wizard
│       │   └── i18n/          # en.json, fr.json, es.json
│       └── api/               # API/backend projects
│           ├── main/          # PTY service, route detection
│           ├── renderer/      # Dashboard, state, terminal panel, route tester, wizard
│           └── i18n/          # en.json, fr.json, es.json
├── scripts/
│   └── build-renderer.js     # esbuild bundler
└── resources/
    └── bundled-skills/        # Built-in skills
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
For translation contributions, see the [Translations (i18n) section](CONTRIBUTING.md#translations-i18n).

To contribute translations, see our [i18n guide](.github/i18n-coverage.md).

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[GPL-3.0](LICENSE)
