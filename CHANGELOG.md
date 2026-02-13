# Changelog

All notable changes to Claude Terminal are documented in this file.

## [0.7.4] - 2026-02-13

### Added
- **Python project type**: auto-detect Python version, virtual environment, dependencies, and entry point
- **API project type**: integrated PTY console, route tester with variables, framework detection (Express, FastAPI, Django, Flask, etc.)
- **Per-project settings**: dedicated modal for project-specific configuration
- **Git commit graph**: visual branch/author filters and commit graph in history panel
- **AI commit messages via GitHub Models API**: replaces Claude CLI approach, with toggle in settings
- **Custom notifications**: BrowserWindow-based notifications replacing native OS notifications
- **Session resume redesign**: improved conversation resume panel with optimizations

### Changed
- Git changes panel redesigned with tracked/untracked collapsible sections
- New project wizard completely redesigned: card grid, progress bar, dynamic type colors
- API routes panel redesigned with improved tester UI
- Terminal PTY output batching improved for large buffers
- Session search optimized with materialization and O(1) lookup

### Fixed
- Python detection now triggers on sidebar and dashboard render
- Quick actions dropdown properly closes other dropdowns before opening
- Git commit message generation properly awaits async call
- Settings saved synchronously before language reload

## [0.7.3] - 2026-02-12

### Added
- **Adaptive terminal state detection**: content-verified ready with `detectCompletionSignal()` and `parseClaudeTitle()`
- **Tool/task detection from OSC title**: auto-names tabs, detects 13 Claude tools
- **Substatus indicator**: yellow pulse for tool calls vs thinking
- **ARIA accessibility**: roles, landmarks, focus-visible styles across the app
- **Reduce motion setting**: disable all animations (OS preference or manual)
- **Background CPU savings**: pause animations when window is hidden
- **Crash logging**: global error handlers with auto-restart and `~/.claude-terminal/crash.log`

### Changed
- Adaptive debounce: 1.5s after thinking, 4s after tool call (was fixed 8s)
- Event delegation for project lists, git branches, tooltips (fewer DOM listeners)
- Adaptive PTY data batching: 4ms idle / 16ms flooding (was fixed 16ms)
- Git queries split into fast-local and heavier batches for faster dashboard
- `getBranches()` skips network fetch by default (faster load)
- Keyboard shortcuts: replaced next/prev terminal with new project, new terminal, toggle file explorer
- Reduced console noise: verbose logs moved to `console.debug`

### Fixed
- Defensive error handling for all process spawns (PTY, MCP, Claude CLI)
- Atomic project save with backup/restore on failure
- GitHub OAuth poll timeout guard (10min max)
- Git exec timeout with explicit process kill
- Editor open error handling

## [0.7.2] - 2026-02-12

### Added
- **Plugin Management**: browse, install plugins from configured marketplaces via Claude CLI
- **Community Marketplaces**: add third-party plugin marketplaces by GitHub URL
- Plugin category filtering and search
- Plugin README viewer in detail modal

### Changed
- Silence verbose debug logs in usage and GitHub services
- Improved single instance lock messaging

### Fixed
- Plugin install command syntax and scope auto-confirmation
- Banner updated with correct app icon

## [0.7.1] - 2026-02-11

### Changed
- Switch license from MIT to GPL-3.0
- Add brand banner to README
- Remove local settings from version control
- Polish global styles and remove dead CSS

### Fixed
- Unify git tab toasts with global toast component

## [0.7.0] - 2026-01-XX

### Added
- **MCP Registry**: browse and search MCP servers from the interface
- **File Explorer**: multi-select, search, git status indicators, inline rename
- **Skill Marketplace**: search, install and cache skills from the community
- Custom NSIS installer images

### Fixed
- Adaptive debounce to prevent false terminal ready status
- Weekly usage percentage parsing order
- Context menu positioning and hide/show race condition
- Updater stale pending cache on version match

## [0.6.0] - 2025-12-XX

### Added
- **Git Tab**: commit history, stash management and PR management
- **Setup Wizard**: first-launch configuration experience
- **Branded Installer**: custom NSIS wizard with branding
- Modular project type registry with FiveM and WebApp plugins
- Session scanning from .jsonl files
- Collapsible projects panel toggle
- Sidebar reorganization with section labels and compact layout

### Changed
- Spawn Claude directly via cmd.exe on Windows
- Improve session titles and memory markdown parser

### Fixed
- Time tracking: calculate today time from sessions with periodic checkpoints
- Terminal: debounced ready detection with broader spinner regex
- Git: use rebase strategy for pull
- GitHub: add timeout to HTTPS requests to prevent hangs
- Context menu: open at cursor position
- Projects: switch in visual sidebar order with Ctrl+arrows

## [0.5.0] - 2025-11-XX

### Added
- **Multi-project Dashboard**: overview with disk cache and type detection
- **GitHub Actions**: status display in dashboard with live CI bar
- **Pull Requests**: section in dashboard
- Quick actions redesign as dropdown with terminal reuse and custom presets
- Settings moved from modal to inline tab
- Unit tests with Jest setup

### Fixed
- Code stats: use git ls-files for accurate counting
- Git: per-project pull/push button state
- Usage: weekly percentage parsing

## [0.4.0] - 2025-10-XX

### Added
- Resizable projects panel
- Compact mode with hover tooltip
- File explorer media preview (images, video, audio)
- Dev instance alongside production

### Fixed
- Replace node require calls with preload API
- Handle non-array details in git toast

## [0.3.0] - 2025-09-XX

### Added
- Dashboard with per-project statistics
- MCP server management
- System tray integration
- Desktop notifications
- Global quick project picker (Ctrl+Shift+P)
- Time tracking with idle detection

## [0.2.0] - 2025-08-XX

### Added
- Multi-terminal management with tabs
- Git integration (branches, pull, push, merge)
- Project folders with drag-and-drop
- Keyboard shortcuts (customizable)
- i18n support (English, French)

## [0.1.0] - 2025-07-XX

### Added
- Initial release
- Electron app with integrated terminal
- Project management
- xterm.js with WebGL rendering
- Basic git operations
