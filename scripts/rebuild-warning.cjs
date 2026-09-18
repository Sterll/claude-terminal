#!/usr/bin/env node
'use strict';

/**
 * Printed when `electron-rebuild` fails during `postinstall`.
 *
 * The rebuild used to end in `|| echo rebuild skipped`, which scrolled past in
 * npm's output and left people with an app that started and then failed the
 * moment a terminal, an account switch or a database query touched one of the
 * three native modules. Failing hard instead is worse in the other direction:
 * `npm install` then stops dead on any machine without a native toolchain,
 * which on Windows means Python plus MSVC, and that turns a first clone into a
 * build problem for someone who only wanted to fix a translation.
 *
 * So the install still succeeds, and the warning is impossible to miss.
 * Everything that does not need a native module works; what does need one says
 * so at the point of use.
 */

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

const lines = [
  '',
  `${RED}${BOLD}  ┌────────────────────────────────────────────────────────────────┐${OFF}`,
  `${RED}${BOLD}  │  Native modules were NOT rebuilt for Electron.                 │${OFF}`,
  `${RED}${BOLD}  └────────────────────────────────────────────────────────────────┘${OFF}`,
  '',
  `  ${YELLOW}The install itself succeeded, so anything that does not touch a${OFF}`,
  `  ${YELLOW}native module will work. These two will not:${OFF}`,
  '',
  '    node-pty        terminals',
  '    keytar          GitHub token, Groq key, account switching',
  '',
  `  ${YELLOW}better-sqlite3 is unaffected: it ships NAPI prebuilds that load${OFF}`,
  `  ${YELLOW}under Electron unchanged, so it is not rebuilt at all.${OFF}`,
  '',
  `  ${BOLD}To fix it:${OFF}  npm run postinstall`,
  '',
  '  That needs a native toolchain:',
  '    Windows   Python 3 and the MSVC build tools',
  '    macOS     Xcode command line tools  (xcode-select --install)',
  '    Linux     build-essential and libsecret-1-dev',
  '',
];

console.warn(lines.join('\n'));
