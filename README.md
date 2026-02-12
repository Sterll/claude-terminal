<p align="center">
  <img src="banner-readme.png" alt="Claude Terminal" width="100%" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.7.2-orange" alt="Version" />
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-blue" alt="Windows" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-green" alt="License" />
  <img src="https://img.shields.io/badge/electron-28-purple" alt="Electron" />
</p>

<p align="center">
  A Windows desktop application for managing <a href="https://github.com/anthropics/claude-code">Claude Code</a> projects with an integrated terminal environment, git workflows, plugin management, and more.
</p>

---

## Features

### Terminals
- Multiple Claude Code terminals per project with tabbed interface
- GPU-accelerated rendering via xterm.js + WebGL (DOM fallback)
- Tab drag-and-drop reordering, renaming, desktop notifications
- Filter terminals by project
- Adaptive ready detection with spinner status

### Project Management
- Organize projects in nested folders with drag-and-drop
- Customize each project with colors and emoji icons
- Quick Actions toolbar: configurable one-click commands per project (build, test, deploy, custom scripts...)
- Built-in file explorer with tree view, multi-select, search, git status indicators, and inline rename
- Modular project type system (standard, FiveM, webapp)

### Git Integration
- **Branches**: switch, create, delete from the toolbar
- **Sync**: pull (rebase), push, merge with conflict detection and resolution
- **Changes panel**: view staged/unstaged/untracked files, stage/unstage and commit
- **Commit history**: browse commits, view diffs, cherry-pick and revert
- **Stash management**: save, apply, drop stashes
- **AI commit messages**: auto-generate conventional commit messages using Claude
- **Pull Requests**: create PRs directly from the app

### GitHub Integration
- OAuth Device Flow authentication (secure, no token copy-paste)
- View CI/CD workflow runs per repository
- View and create pull requests
- Token stored securely in Windows Credential Manager via keytar

### Dashboard
- Per-project overview: current branch, commits ahead/behind, recent commits, contributors
- Code statistics: lines of code by language, file count, commit count
- Active terminals count
- Claude API usage monitoring with auto-refresh

### Time Tracking
- Automatic session detection per project (15-min idle timeout, sleep/wake detection)
- View by period: today, this week, this month, custom range
- Stats: daily average, longest streak, evolution charts, recent sessions
- Midnight rollover and periodic checkpoints

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

### Other
- System tray integration with accent-colored icon
- Global shortcuts (`Ctrl+Shift+P` quick picker, `Ctrl+Shift+T` new terminal)
- Single instance lock
- Custom NSIS installer with branded images
- FiveM server management (launch, integrated console, resource scanning)
- Web app management with framework auto-detection

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code](https://github.com/anthropics/claude-code) installed globally
- Windows 10 or 11

## Installation

Download the latest installer from [Releases](https://github.com/Sterll/claude-terminal/releases).

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
# Build Windows installer (NSIS)
npm run build
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
├── styles.css                 # Application styles (~6000 lines)
├── src/
│   ├── main/                  # Main process
│   │   ├── index.js           # Bootstrap & lifecycle
│   │   ├── preload.js         # Context bridge API
│   │   ├── ipc/               # IPC handlers
│   │   │   ├── terminal.ipc.js
│   │   │   ├── git.ipc.js
│   │   │   ├── github.ipc.js
│   │   │   ├── claude.ipc.js
│   │   │   ├── usage.ipc.js
│   │   │   ├── mcp.ipc.js
│   │   │   ├── mcpRegistry.ipc.js
│   │   │   ├── plugin.ipc.js
│   │   │   ├── marketplace.ipc.js
│   │   │   ├── fivem.ipc.js
│   │   │   ├── project.ipc.js
│   │   │   └── dialog.ipc.js
│   │   ├── services/
│   │   │   ├── TerminalService.js
│   │   │   ├── PluginService.js
│   │   │   ├── MarketplaceService.js
│   │   │   ├── GitHubAuthService.js
│   │   │   ├── UsageService.js
│   │   │   ├── McpService.js
│   │   │   ├── McpRegistryService.js
│   │   │   ├── UpdaterService.js
│   │   │   └── FivemService.js
│   │   ├── windows/
│   │   │   ├── MainWindow.js
│   │   │   ├── QuickPickerWindow.js
│   │   │   ├── SetupWizardWindow.js
│   │   │   └── TrayManager.js
│   │   └── utils/
│   │       ├── paths.js
│   │       ├── git.js
│   │       └── commitMessageGenerator.js
│   └── renderer/              # Renderer process
│       ├── services/
│       │   ├── ProjectService.js
│       │   ├── TerminalService.js
│       │   ├── SettingsService.js
│       │   ├── DashboardService.js
│       │   ├── GitTabService.js
│       │   ├── TimeTrackingDashboard.js
│       │   ├── SkillService.js
│       │   ├── AgentService.js
│       │   ├── McpService.js
│       │   └── FivemService.js
│       ├── state/
│       │   ├── State.js           # Base observable class
│       │   ├── projects.state.js
│       │   ├── terminals.state.js
│       │   ├── settings.state.js
│       │   ├── git.state.js
│       │   ├── mcp.state.js
│       │   ├── fivem.state.js
│       │   └── timeTracking.state.js
│       ├── ui/components/
│       │   ├── ProjectList.js
│       │   ├── TerminalManager.js
│       │   ├── FileExplorer.js
│       │   ├── Modal.js
│       │   ├── Toast.js
│       │   ├── ContextMenu.js
│       │   ├── Tab.js
│       │   ├── CustomizePicker.js
│       │   └── QuickActions.js
│       ├── features/
│       │   ├── QuickPicker.js
│       │   ├── KeyboardShortcuts.js
│       │   └── DragDrop.js
│       ├── i18n/
│       │   └── locales/
│       │       ├── en.json
│       │       └── fr.json
│       └── utils/
│           ├── dom.js
│           ├── color.js
│           ├── format.js
│           ├── paths.js
│           ├── fileIcons.js
│           └── syntaxHighlight.js
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
