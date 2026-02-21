<p align="center">
  <img src="banner-readme.png" alt="Claude Terminal" width="100%" />
</p>

<p align="center">
  <img src="https://img.shields.io/github/downloads/Sterll/claude-terminal/total?color=d97706&label=downloads" alt="Downloads" />
  <img src="https://img.shields.io/badge/version-0.9.6-orange" alt="Version" />
  <img src="https://img.shields.io/badge/platform-Windows%20|%20macOS%20|%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-green" alt="License" />
  <img src="https://img.shields.io/badge/electron-28-purple" alt="Electron" />
</p>

<p align="center">
  A cross-platform desktop application for managing <a href="https://github.com/anthropics/claude-code">Claude Code</a> projects with an integrated terminal environment, git workflows, plugin management, and more.
</p>

<p align="center">
  <a href="https://claudeterminal.dev">Website</a> &bull;
  <a href="https://github.com/Sterll/claude-terminal/releases">Download</a> &bull;
  <a href="https://x.com/ClaudeTerminal_">Twitter</a> &bull;
  <a href="https://buymeacoffee.com/claudeterminal">Buy Me a Coffee</a>
</p>

---

## Features

### Chat UI (Claude Agent SDK)
- Built-in chat interface powered by the Claude Agent SDK with streaming responses
- Real-time markdown rendering: code blocks, tables, lists, headers, links
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
- Type @project to attach README.md and file tree from any project as context
- Type **@context** to inject a context pack or **@prompt** to insert a saved prompt template directly into your message
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
- Built-in file explorer with tree view, multi-select, search, git status indicators, and inline rename
- Modular project type system (standard, FiveM, webapp, Python, API, Minecraft)
- Per-project settings modal

### Git Integration
- **Branches**: switch, create, delete with tree view of local/remote branches
- **Sync**: pull (rebase), push, merge with conflict detection and resolution
- **Changes panel**: view staged/unstaged/untracked files, stage/unstage and commit
- **Commit history**: IntelliJ-style commit graph with SVG rendering, branch/author filtering, infinite scroll
- **Cherry-pick & revert**: advanced commit operations from history
- **Worktree management**: create, switch, and delete Git worktrees with quick-switch badge in the toolbar
- **Stash management**: save, apply, drop stashes
- **AI commit messages**: auto-generate conventional commit messages via GitHub Models API
- **Pull Requests**: create and view PRs directly from the app

### GitHub Integration
- OAuth Device Flow authentication (secure, no token copy-paste)
- View CI/CD workflow runs per repository
- View and create pull requests
- Token stored securely via keytar (Windows Credential Manager, macOS Keychain, Linux libsecret)

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
- Language: English and French with auto-detection
- Editor integration: VS Code, Cursor, WebStorm, IntelliJ IDEA
- Customizable keyboard shortcuts
- Desktop notification preferences
- Close behavior (ask, minimize to tray, or quit)
- Launch at startup toggle
- Auto-updates with background download and install banner

### Other
- First-launch setup wizard with optional hooks installation
- System tray integration with accent-colored icon
- Custom toast notifications with stacking, click-through transparency, and action buttons
- Global shortcuts (`Ctrl+Shift+P` / `Cmd+Shift+P` quick picker, `Ctrl+Shift+T` / `Cmd+Shift+T` new terminal)
- Single instance lock
- Custom NSIS installer with branded images (Windows), DMG (macOS), AppImage (Linux)
- FiveM server management (launch, integrated console, resource scanning, resource creator wizard)
- Minecraft project type with Java plugin generator and platform-aware launch scripts
- Web app management with framework auto-detection
- Python project detection (version, venv, dependencies, entry point)
- API project type with integrated route tester, variables, and console

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

> **macOS note:** If you see *"Claude Terminal is damaged and can't be opened"*, this is because the app is not code-signed yet. Run this command to fix it:
> ```bash
> xattr -cr /Applications/Claude\ Terminal.app
> ```

Or build from source:

```bash
git clone https://github.com/Sterll/claude-terminal.git
cd claude-terminal
npm install
```

## Usage

```bash
# Build renderer then run the application
npm run build:renderer; npx electron .

# Run with DevTools open
npm run build:renderer; npx electron . --dev

# Build renderer in watch mode (for development)
npm run watch
```

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

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
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
├── styles.css                 # Application styles (~6000 lines)
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
│       │   └── i18n/          # en.json, fr.json
│       ├── webapp/            # Web app projects
│       │   ├── main/          # IPC & service
│       │   ├── renderer/      # Dashboard, state, terminal panel, wizard
│       │   └── i18n/          # en.json, fr.json
│       ├── python/            # Python projects (detection only)
│       │   ├── main/          # Detection service
│       │   ├── renderer/      # Dashboard, state, wizard
│       │   └── i18n/          # en.json, fr.json
│       ├── minecraft/          # Minecraft Java plugin projects
│       │   ├── main/          # Detection service, plugin generator
│       │   ├── renderer/      # Dashboard, state, wizard
│       │   └── i18n/          # en.json, fr.json
│       └── api/               # API/backend projects
│           ├── main/          # PTY service, route detection
│           ├── renderer/      # Dashboard, state, terminal panel, route tester, wizard
│           └── i18n/          # en.json, fr.json
├── scripts/
│   └── build-renderer.js     # esbuild bundler
└── resources/
    └── bundled-skills/        # Built-in skills
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[GPL-3.0](LICENSE)
