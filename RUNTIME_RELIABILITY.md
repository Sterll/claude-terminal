# Reliability and data protection

Cloud agent execution requires one user per instance and dedicated volumes. Set
`CLOUD_ENABLED=false` for a multi-user relay/sync without agent execution. Imports
are staged, existing destinations are preserved, and concurrent metadata writes
share a lock. Failed sync writes remain queued. Database passwords are resolved
from the OS keychain; MCP synchronization preserves local secret values.

## Runtime and regression checks

Development and CI use Node.js 24.15+ and Electron 43 (Chromium 150 / Node.js 24).
The desktop runtime requires macOS 12+; native modules are rebuilt during installation,
and a failed rebuild now fails the install instead of silently shipping unusable binaries.
Run `npm test`, `npm run lab`, `npm run build:renderer`, and `npm run test:runtime`.
The runtime smoke uses a temporary home and verifies SQLite, PTY, keytar loading,
file/Git triggers, the bundled PDF viewer, and remote reconnect/revocation.
On headless Linux use `xvfb-run -a npm run test:runtime` and install `libsecret-1-dev`.
Cloud regressions run with `npm ci --prefix cloud && npm test --prefix cloud`.

## Synchronization and security boundaries

Skill sync includes resource files (binary files and executable bits), both agent formats,
and explicit deletion markers. A bundle is limited to 5 MiB of local files / 10,000 files;
links and paths escaping the bundle are rejected. Upgrade both clients before syncing
these richer bundles. The managed `claude-terminal` MCP is machine-local and uses the
bundled Electron executable in Node mode so native database modules use the same ABI.

Renderer filesystem access is limited to app data, registered projects/worktrees, and
paths selected through native dialogs. App resources and the Claude global configuration
are read-only through this generic bridge; MCP changes use guarded main-process writers.
Main-frame IPC senders and exact application document URLs are checked. Microphone and sanitized clipboard-write
requests are restricted to the main application document. Quick Picker and notification
windows are sandboxed. Main/setup still require the existing Node preload; completing
that sandbox migration requires replacing the remaining synchronous filesystem bridge.

Project ZIP exports preserve Unicode and newline filenames and fail on archive warnings.
The sensitive-file filter covers working-tree files. When `includeGit` is requested,
Git metadata/history is included and may contain previously committed secrets.
HTTP tester responses are capped at 5 MiB and 30 seconds total and can be cancelled.

## Workflow Hub storage

The hub now paginates the complete KV catalogue and stores import counts and hourly
submission quotas in per-workflow/per-IP SQLite Durable Objects. The migration is in
`hub-worker/wrangler.toml`; applying it requires deploying the updated Worker configuration.
Existing import totals seed each counter on its first increment. Quotas start a fresh
window when upgrading. Catalogue documents and their 60-second index still use KV's
eventual consistency; import increments no longer rewrite workflow documents.

Validate locally with `npm ci --prefix hub-worker && npm test --prefix hub-worker`.
The compatibility date is aligned with the Miniflare runtime used by the installed Wrangler.
No production deployment is part of these audit pull requests.
