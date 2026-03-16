# Changelog

All notable changes to Claude Terminal are documented in this file.

## [1.2.0] - 2026-03-15

### Added
- **Database**: query history, saved queries, and SQL autocompletion
- **Database**: export results, row counts, row selection, column resize and FK visualization
- **Database**: cell viewer modal, sidebar resize, connection string display, explain plan and multi-tab queries
- **Database**: Redis support via MCP tools
- **Database**: MariaDB support
- **Git**: 13 new operations — rebase, tags, blame, fetch, rename branch, remote delete, file history, commit file diffs, issues, PR merge
- **Git**: smart commit multi-group workflow (split changes by area with per-group messages)
- **Git**: conflict resolution (ours/theirs), branch search filter, diff viewer with line numbers, button loading states
- **Sessions**: delete sessions from UI, filter by git branch, export as Markdown/JSON
- **Sessions**: CLAUDE.md review prompt after significant sessions
- **Chat**: initializing state indicator, interruption marker, permission timeout UX
- **Chat**: project-contextual followup suggestions
- **Chat**: async skill/agent generation with real-time progress display
- **Chat**: 20+ improvements from audit (2 batches)
- **File Explorer**: copy, duplicate, content search, sorting and configurable ignore patterns
- **Dashboard**: yearly contribution graph (GitHub-style)
- **Time Tracking**: daily goal, period comparison and data export
- **Time Tracking**: stat tooltips (streak, avg, sessions, top project)
- **Kanban**: priority levels and due dates
- **Quick Actions**: variable substitution and custom environment variables
- **Projects**: archive, tags, and per-project chat settings
- **Projects**: search/filter in project list
- **Projects**: close terminals on project delete, sync rename to tabs
- **Remote**: push notifications for mobile PWA (done, error, permission)
- **Remote**: persistent PIN, connected clients management (kick)
- **Settings**: import/export settings as JSON
- **Settings**: custom editor support
- **Settings**: performance tab with disable animations toggle
- **Settings**: validation, save feedback, setup wizard rerun
- **Plugins**: uninstall plugins from UI
- **Updater**: changelog fetch and native OS notification
- **UI/UX**: improved quick picker (performance, clickable prefixes, i18n)
- **UI/UX**: improved modals, toasts, and file explorer accessibility
- **UI/UX**: sidebar scroll preservation, active tab persistence, tooltips
- **Tests**: +93 tests from audit, IPC/security/integration tests, service tests, state/i18n coherence tests, utils tests

### Changed
- Drag-drop improved with handles and invalid drop feedback
- TODO suggestions moved from placeholder to followup chips
- Project item borders and drag-active outlines removed for cleaner look

### Performance
- Throttle dragover and disable transitions during drag
- Reduce-motion media query support

### Fixed
- Chat race conditions in naming/suggestion flows and cleanup leaks
- Memory leaks in dashboard, state, and marketplace listeners
- RemoteServer and RemotePanel (4 bugs)
- File Explorer drag listener accumulation and move conflict
- Terminal (5 bugs across terminal-related files)
- IPC error handling and git utils hardening
- State mutation prevention, locked backup, and data loss bugs
- CSS vendor fix for xterm and litegraph runtime refs
- Services cleanup and error resilience on shutdown

## [1.1.1] - 2026-03-11

### Added
- **Database**: toggle for allowing destructive queries (DROP, DELETE, TRUNCATE) with safety confirmation
- **Control Tower**: collapsible agent cards for a cleaner multi-session overview

### Changed
- Spanish language badge added to README and CI workflow

### Fixed
- Database MCP module resolution in packaged app

## [1.0.2] - 2026-03-03

### Added
- **Cloud Upload Progress**: real-time progress bar with percentage tracking in cloud panel and toast notifications

### Changed
- Cloud upload optimized with store mode, real progress tracking, and dynamic timeout
- Workflow node descriptions and database config field labels now fully translated

### Fixed
- Cloud server file size limit increased from 100MB to 5GB
- Cloud upload Content-Length header set correctly for multipart uploads
- Workflow keyboard shortcuts no longer fire when canvas is hidden
- Workflow field renderers now access required global variables
- Project-type tabs excluded from session restore to prevent orphan tabs
- Copy-paste now works in project-type read-only consoles (FiveM, Minecraft, etc.)
- Window state save no longer fails when antivirus locks the settings file on Windows

## [1.0.0] - 2026-03-02

### Added
- **Workflow Engine**: full visual automation system with custom canvas engine, Unreal Blueprint-style typed data pins, 15+ node types (shell, git, HTTP, Claude, condition, loop, transform, switch, subworkflow, database, file, project, time, variable, trigger), AI assistant for real-time graph editing, undo/redo, copy/paste, snap-to-grid, minimap, comments, and run history with live loop progress
- **Workflow Node Registry**: modular `.node.js` architecture with generic field renderer, custom field renderers, trigger registries, and IPC-exposed node definitions
- **Workflow Community Hub**: publish and browse community workflows with author identity
- **Cloud Sync**: self-hosted Docker relay server with project upload, auto-sync via file watcher, incremental sync with conflict resolution, diff modal for local vs cloud comparison, headless Claude sessions, user profiles, and automated install script with reverse proxy and SSL setup
- **Database Panel**: multi-driver support (SQLite, MySQL, PostgreSQL, MongoDB) with split-pane data browser, inline editing, SQL query editor with syntax highlighting and templates, insert/delete rows, search filter, and connection pooling
- **MCP Server**: unified `claude-terminal` MCP server exposing workflow tools (create, edit, trigger, diagnose, variables, run logs), database tools (query, export, schema, stats), project and time tracking tools, quick action triggers, and FiveM/WebApp project tools
- **Telemetry**: anonymous opt-in telemetry with consent UI, geolocation disclosure, feature usage pings, admin dashboard with charts, and privacy-first batching
- **WebApp Live Preview**: webview replacing iframe, visual feedback with multi-pin annotations, responsive breakpoint checker, auto-detect visual problems scanner, ruler spacing measurement tool, and accessibility audit with axe-core
- **Remote Control**: redesigned mobile PWA with modern dark theme, cloud relay integration, chat event buffering for late-joining clients, tabbed local/cloud layout, and help guide
- **Session Restore**: save and restore full workspace sessions across restarts
- **Terminal Session Persistence**: persist terminal sessions with Claude session resume support
- **Markdown Viewer**: integrated viewer for `.md` files in the terminal panel
- **Dashboard Insights**: project insights section with commit heatmap and health badges
- **File Explorer Watcher**: automatic file tree updates on filesystem changes
- **Tab Context Menus**: right-click context menu on all tab types (terminal, chat, etc.)
- **Terminal Shortcuts Settings**: configurable terminal shortcuts with Ctrl+Tab tab switching
- **Window State Persistence**: remember window position, size, and maximized state across restarts
- **Dotfile Visibility**: settings toggle to show/hide dotfiles in file explorer
- **Tab Renaming**: opt-in terminal tab renaming on slash commands
- **Chat Question Preview**: markdown preview for question options in chat
- **Snapcraft & Flatpak**: Linux packaging for Snap Store and Flathub
- **i18n Project Types**: full internationalization support for all project-type panels

### Changed
- Workflow editor completely rebuilt: replaced LiteGraph with custom canvas engine, Blueprint-style visual redesign, shared schema as single source of truth, BFS execution order
- Remote panel redesigned with tabbed local/cloud layout and dedicated Cloud sidebar tab
- Database connection cards redesigned with polished action buttons
- Workflow step picker redesigned with pipeline layout and card grid
- Mobile PWA redesigned with modern dark theme and syntax highlighting for tool outputs
- Git changes panel now includes inline diff viewer and stash management
- Worktrees open as tabs in the same project instead of creating new projects
- Pane divider improved with better constraints and bug fixes
- Cross-platform shell detection improved with graceful SIGTERM before SIGKILL
- Project save uses exponential backoff retry on failure

### Fixed
- **Security**: CSP headers on all windows, SQL/NoSQL injection prevention, shell injection protection, XSS sanitization, path traversal validation on Windows, ReDoS protection in workflow regex, git clone URL scheme validation, increased PIN entropy from 4 to 6 digits, atomic writes for config files, WebSocket session token revocation on disconnect
- **Performance**: event delegation for project list drag-and-drop and workflow cards, LRU cache limits for dashboard, async PATH resolution, throttled workflow render loop (30fps), chat streaming optimization with memory cleanup, connection pool limits with idle eviction
- **Stability**: MCP auto-restart on unexpected process crash, PTY cleanup on exit, terminal event listener disposal to prevent memory leaks, AbortSignal memory leak fix in parallel workflow loops, chat post-close rejection handling, notification bell state persistence across restarts
- Shift+Enter race condition in terminal and chat input eliminated
- Windows taskbar pin preserved across updates
- Ctrl+Shift+V paste fixed via Electron clipboard IPC fallback

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
