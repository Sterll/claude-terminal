<p align="center">
  <img src="banner-readme.png" alt="Claude Terminal" width="100%" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-blue" alt="Windows" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-green" alt="License" />
  <img src="https://img.shields.io/badge/electron-28-purple" alt="Electron" />
</p>

<p align="center">
  A Windows desktop application for managing <a href="https://github.com/anthropics/claude-code">Claude Code</a> projects with an integrated terminal environment, git workflows, time tracking, and more.
</p>

## Features

### Terminals
- Multiple Claude Code terminals per project with tabbed interface
- GPU-accelerated rendering via xterm.js + WebGL (DOM fallback)
- Tab drag-and-drop reordering, renaming, desktop notifications
- Filter terminals by project

### Project Management
- Organize projects in nested folders with drag-and-drop
- Customize each project with colors and emoji icons
- Quick Actions toolbar: configurable one-click commands per project (build, test, deploy, custom scripts...)
- Built-in file explorer with tree view

### Git Integration
- Branch switching, creation and deletion from the toolbar
- Pull, push, merge with conflict detection
- Changes panel: view staged/unstaged/untracked files, stage and commit
- Auto-generate commit messages using Claude
- Stash list in dashboard

### Dashboard
- Per-project overview: current branch, commits ahead/behind, recent commits, contributors
- Code statistics: lines of code by language, file count, commit count
- Active terminals count

### Time Tracking
- Automatic session detection per project (15-min idle timeout, sleep/wake detection)
- View by period: today, this week, this month, custom range
- Stats: daily average, longest streak, evolution charts, recent sessions

### Skills & Agents
- Browse and manage Claude Code skills and agents
- View SKILL.md and agent configuration files

### MCP Servers
- Configure, start and stop MCP servers
- Environment variable configuration

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

### Other
- System tray integration with accent-colored icon
- Global shortcuts (`Ctrl+Shift+P` quick picker, `Ctrl+Shift+T` new terminal)
- Auto-updates via GitHub releases
- Single instance lock
- FiveM server management (launch, integrated console)

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code](https://github.com/anthropics/claude-code) installed globally
- Windows 10 or 11

## Installation

```bash
git clone https://github.com/Sterll/claude-terminal.git
cd claude-terminal
npm install
```

## Usage

```bash
# Run the application
npm start

# Run with DevTools open
npm run start:dev
```

## Building

```bash
# Build Windows installer (NSIS)
npm run build
```

The installer will be generated in the `build/` directory.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+P` | Quick project picker (global) |
| `Ctrl+Shift+T` | New terminal in current project (global) |
| `Ctrl+T` | Create terminal |
| `Ctrl+W` | Close terminal |
| `Ctrl+Tab` | Next terminal |
| `Ctrl+Shift+Tab` | Previous terminal |
| `Ctrl+P` | Quick picker |
| `Ctrl+,` | Settings |
| `Escape` | Close dialogs |

Shortcuts are customizable in Settings.

## Project Structure

```
claude-terminal/
├── main.js                  # Electron entry point
├── renderer.js              # Main renderer logic
├── index.html               # Main window UI
├── styles.css               # Application styles
├── src/
│   ├── main/                # Main process
│   │   ├── index.js         # Bootstrap & lifecycle
│   │   ├── preload.js       # Context bridge API
│   │   ├── ipc/             # IPC handlers (terminal, git, mcp, dialog, fivem, project)
│   │   ├── services/        # Terminal, MCP, Updates, FiveM services
│   │   ├── windows/         # MainWindow, QuickPicker, TrayManager
│   │   └── utils/           # Paths, git utilities
│   └── renderer/            # Renderer process
│       ├── services/        # IPC wrappers
│       ├── state/           # Reactive state management (observable pattern)
│       ├── ui/components/   # UI components (ProjectList, TerminalManager, Modal...)
│       ├── features/        # QuickPicker, KeyboardShortcuts, DragDrop
│       ├── i18n/            # Translations (en, fr)
│       └── utils/           # DOM, color, format, paths helpers
└── assets/                  # Icons and resources
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[GPL-3.0](LICENSE)
