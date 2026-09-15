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
