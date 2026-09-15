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
requests are restricted to the main application document. Main, setup, Quick Picker and
notification windows are sandboxed. The preload imports only Electron; native filesystem
operations execute in the main process through an explicit, authorized IPC allowlist.
Legacy synchronous callers remain supported; asynchronous callers use invoke handlers.

Project ZIP exports preserve Unicode and newline filenames and fail on archive warnings.
The sensitive-file filter covers working-tree files. When `includeGit` is requested,
Git metadata/history is included and may contain previously committed secrets.
HTTP tester display responses are capped at 5 MiB and 30 seconds total. “Save to disk”
streams the complete response to a native-dialog destination, with a 64 KiB preview,
progress, cancellation and a 30-minute deadline. Downloads and CSV/JSON result exports
replace their destination only after completion; cancellation removes their temporary
file. Exports retry from the beginning using the same result data.

## Local recovery and long operations

The existing settings search and command-palette links are preserved, including the
new legacy-backup controls.
Control Tower adds unavailable workflow triggers, latest failed runs and sync conflicts;
its actions open the existing workflow or conflict views, or rebuild a failed trigger.
Trigger state includes missing projects, invalid cron/regex configuration, watcher errors
and failed automatic dispatch. Git worktrees watch their own HEAD log.

Git commit/PR generation, cloning and web-project scaffolding support cancellation.
Clicking Create/Generate again retries with the retained form values, from the beginning.
Clone/scaffold jobs use isolated staging directories and preserve existing destinations.
Scaffold names must be valid lowercase npm-style package names. Commands and template
arguments are chosen in the main process; no process execution API is exposed to renderers.
GitHub credentials apply only to the configured host and are passed through temporary Git
configuration in the child environment, rather than persisted in the cloned remote URL.

Database migration fails closed if its configuration or keychain is unavailable. Known
legacy database/MCP backups are scrubbed only after an AES-256-GCM recovery archive has
been written and verified. The random encryption key is stored in the OS keychain;
archives live under `~/.claude-terminal/secret-backups`. Settings → General → Legacy
secret backups reports failures, retries migration and recovers an archive to a separate
plaintext file chosen through a native dialog. Recovery requires the original computer’s
keychain. Only known database fields and managed MCP `CT_DB_PASS*` variables are scrubbed;
other applications’ secrets and arbitrary user backups are outside this migration.

Electron and the external MCP share one fail-closed file lock implementation. A timed-out
lock is never broken automatically. If a crash leaves a lock file, stop **all** app and
MCP writers before removing that specific abandoned `.lock` file, then retry.

`npm run test:upgrade` boots the complete app against an isolated old-format profile and
verifies data retention, secret migration, settings search, trigger alerts and sandboxed
windows. The OS credential store is an in-memory test double; native module loading is
covered separately by `npm run test:runtime`. Neither test uses a production profile.

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
