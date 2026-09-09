#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * The 125 Jest suites all run in jsdom against a mocked `window.electron_api`,
 * which means nothing in the repository has ever asserted that the actual
 * application starts. Every regression of the shape "the window opens but panel
 * X throws on first render" has had to be found by a human opening the app.
 * That is the gap this covers, and only that: it is a smoke test, not a
 * feature suite.
 *
 * Three assertions:
 *
 *   1. The window opens and the custom titlebar renders.
 *   2. Every sidebar tab can be opened without a renderer console error or an
 *      uncaught page error.
 *   3. ErrorLogService recorded no `critical` entry during the run — which, per
 *      that service, means no uncaughtException and no unhandledRejection in
 *      the main process.
 *
 * Isolation. The run must not touch the developer's real data, and must not be
 * disturbed by their running copy of the app:
 *
 *   - HOME / USERPROFILE point at a throwaway directory, so `os.homedir()`
 *     relocates BOTH `~/.claude-terminal` and `~/.claude` for the main process
 *     and the renderer alike. This is why the env is overridden rather than
 *     adding a CT_DATA_DIR to paths.js: only one of the two is app data.
 *   - `--user-data-dir` gives Electron its own profile, which also scopes
 *     `app.requestSingleInstanceLock()`. Without it the launch would hit the
 *     developer's existing instance and quit immediately.
 *   - settings.json is seeded with `setupCompleted: true`, because a genuinely
 *     first-launch profile opens the setup wizard instead of the main window.
 *     Networked and background features are seeded off: this test is about the
 *     UI booting, not about reaching a relay.
 *
 * Run with `npm run test:e2e`. Kept out of `npm test` on purpose: it needs a
 * display (`xvfb-run` on Linux CI) and a built renderer bundle.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');

/** Per-tab budget for the panel to mount and settle. */
const TAB_SETTLE_MS = 700;
/** Hard ceiling on the whole run, so CI cannot hang on a stuck window. */
const RUN_TIMEOUT_MS = 120_000;

// ── Reporting ────────────────────────────────────────────────────────────────

const failures = [];
let checksRun = 0;

function check(name, ok, detail) {
  checksRun++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

// ── Throwaway profile ────────────────────────────────────────────────────────

/**
 * Build an isolated home directory with just enough settings to reach the main
 * window, and return the paths plus a cleanup function.
 */
function makeProfile() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-e2e-'));
  const home = path.join(base, 'home');
  const userData = path.join(base, 'user-data');
  fs.mkdirSync(path.join(home, '.claude-terminal'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });

  fs.writeFileSync(
    path.join(home, '.claude-terminal', 'settings.json'),
    JSON.stringify({
      setupCompleted: true,
      language: 'en',
      // Everything that would reach the network, spawn a server or ask the user
      // a question stays off. A smoke test should fail because a panel threw,
      // not because a relay was unreachable.
      telemetryEnabled: false,
      telemetryConsentShown: true,
      hooksEnabled: false,
      hooksConsentShown: true,
      remoteEnabled: false,
      cloudAutoConnect: false,
      cloudAutoSync: false,
      claudeRemoteControlEnabled: false,
      chromeBridgeEnabled: false,
      discordRpcEnabled: false,
      restoreTerminalSessions: false,
      globalShortcutsEnabled: false,
      notificationsEnabled: false,
    }, null, 2)
  );

  // No projects: the tree renders its empty state, which is a state worth
  // booting anyway, and it keeps the run from touching real repositories.
  fs.writeFileSync(
    path.join(home, '.claude-terminal', 'projects.json'),
    JSON.stringify({ projects: [], folders: [], rootOrder: [] }, null, 2)
  );

  return {
    home,
    userData,
    cleanup() {
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // A locked file on Windows is not worth failing the run over; the
        // directory is under the OS temp dir either way.
      }
    },
  };
}

// ── Test ─────────────────────────────────────────────────────────────────────

async function run() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'renderer.bundle.js'))) {
    console.error('dist/renderer.bundle.js is missing. Run `npm run build:renderer` first.');
    process.exit(1);
  }

  const profile = makeProfile();
  let app;

  // Collected across the whole session and attributed to whichever tab was
  // open at the time, so a failure names the panel that produced it.
  const consoleErrors = [];
  let currentTab = 'startup';

  try {
    app = await electron.launch({
      args: [ROOT, `--user-data-dir=${profile.userData}`],
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: profile.home,
        USERPROFILE: profile.home,
        // Electron reads this on Windows for some path lookups, and leaving the
        // developer's value would leak the real profile back in.
        APPDATA: path.join(profile.home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(profile.home, 'AppData', 'Local'),
        CT_DATA_DIR: path.join(profile.home, '.claude-terminal'),
        CT_E2E: '1',
      },
      timeout: 60_000,
    });

    const win = await app.firstWindow({ timeout: 60_000 });

    win.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push({ tab: currentTab, text: msg.text() });
    });
    win.on('pageerror', (err) => {
      consoleErrors.push({ tab: currentTab, text: `uncaught: ${err.message}` });
    });

    await win.waitForLoadState('domcontentloaded');

    // ── 1. The window opens and the shell renders ───────────────────────────

    const title = await win.textContent('.titlebar-title').catch(() => null);
    check('window opens with its custom titlebar', title === 'Claude Terminal', `got ${JSON.stringify(title)}`);

    await win.waitForSelector('.nav-tab[data-tab]', { timeout: 30_000 });

    // ── 2. Every sidebar tab opens without a console error ──────────────────

    const tabs = await win.$$eval('.nav-tab[data-tab]', (els) =>
      els.map((el) => el.dataset.tab)
    );
    check('sidebar exposes its tabs', tabs.length > 0, `found ${tabs.length}`);

    for (const tab of tabs) {
      currentTab = tab;
      const before = consoleErrors.length;

      await win.click(`.nav-tab[data-tab="${tab}"]`);
      await win.waitForTimeout(TAB_SETTLE_MS);

      const produced = consoleErrors.slice(before);
      check(
        `tab "${tab}" opens cleanly`,
        produced.length === 0,
        produced.map((e) => e.text).join(' | ').slice(0, 300)
      );
    }

    currentTab = 'teardown';

    // ── 3. The main process logged nothing critical ─────────────────────────

    const stats = await win.evaluate(async () => {
      try {
        return await window.electron_api.errorLog.getStats();
      } catch (e) {
        return { unavailable: String(e && e.message) };
      }
    });

    if (stats && stats.unavailable) {
      check('error log is reachable', false, stats.unavailable);
    } else {
      check(
        'main process logged no critical error',
        (stats?.critical ?? 0) === 0,
        `critical=${stats?.critical}, domains=${JSON.stringify(stats?.domains || {})}`
      );

      // Not a failure: warnings are the normal degraded-path noise (no Claude
      // CLI credentials in a throwaway home, no network). Printed because a
      // sudden jump is worth a human look.
      console.log(`\n     (main process warnings during the run: ${stats?.warning ?? 0})`);
    }
  } finally {
    if (app) await app.close().catch(() => {});
    profile.cleanup();
  }

  // ── Report ────────────────────────────────────────────────────────────────

  if (failures.length) {
    console.error(`\n${failures.length} of ${checksRun} smoke checks failed:\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(`\nSmoke test passed (${checksRun} checks).`);
}

const guard = setTimeout(() => {
  console.error(`\nSmoke test exceeded ${RUN_TIMEOUT_MS / 1000}s and was aborted.`);
  process.exit(1);
}, RUN_TIMEOUT_MS);
guard.unref();

run().catch((err) => {
  console.error('\nSmoke test crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
