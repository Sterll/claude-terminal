#!/usr/bin/env node
/**
 * A stand-in for `claude auth login`, for the sign-in tests.
 *
 * Prints what the CLI prints (2.1.260), the URL wrapped in an OSC 8 hyperlink,
 * then reads `code#state` lines from stdin the way the CLI does. `FAKE_LOGIN_MODE`
 * picks the outcome:
 *
 *   code (default)   wait for a code: one without "#" is refused and the CLI
 *                    keeps waiting, "bad#..." fails the exchange (exit 1), any
 *                    other succeeds
 *   callback         succeed at once, as when the browser redirect reaches
 *                    the CLI and no code is needed
 *   empty            exit 0 without writing credentials
 *   hang             print the URL and never finish
 *
 * On success it writes credentials to $CLAUDE_SECURESTORAGE_CONFIG_DIR (the file
 * store, as off macOS) and `oauthAccount` to $CLAUDE_CONFIG_DIR/.claude.json,
 * from FAKE_LOGIN_TOKEN, FAKE_LOGIN_EMAIL, FAKE_LOGIN_ACCOUNT and FAKE_LOGIN_ORG.
 *
 * `FAKE_LOGIN_ENV_FILE`, when set, receives the environment it ran under.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const LOGIN_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=test&state=abc123';

const args = process.argv.slice(2).join(' ');
if (args !== 'auth login --claudeai') {
  process.stderr.write(`unexpected arguments: ${args}\n`);
  process.exit(2);
}

const env = process.env;
if (env.FAKE_LOGIN_ENV_FILE) fs.writeFileSync(env.FAKE_LOGIN_ENV_FILE, JSON.stringify(env));

function succeed({ withCredentials = true } = {}) {
  if (withCredentials) {
    const token = env.FAKE_LOGIN_TOKEN || 'fresh-token';
    fs.writeFileSync(path.join(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        refreshToken: `refresh-${token}`,
        expiresAt: 1893456000000,
        refreshTokenExpiresAt: 1900000000000,
        subscriptionType: 'max'
      }
    }));
    fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({
      oauthAccount: {
        emailAddress: env.FAKE_LOGIN_EMAIL || 'someone@example.com',
        accountUuid: env.FAKE_LOGIN_ACCOUNT || 'acct-1',
        organizationUuid: env.FAKE_LOGIN_ORG || 'org-1'
      }
    }));
  }
  process.stdout.write('Login successful.\n');
  process.exit(0);
}

const mode = env.FAKE_LOGIN_MODE || 'code';

process.stdout.write('Opening browser to sign in…\n');
process.stdout.write(`If the browser didn't open, visit: \x1b]8;;${LOGIN_URL}\x07${LOGIN_URL}\x1b]8;;\x07\n`);
process.stdout.write('Paste code here if prompted > ');

if (mode === 'callback') {
  succeed();
} else if (mode === 'empty') {
  succeed({ withCredentials: false });
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const [code, state] = line.trim().split('#');
    if (!code || !state) {
      process.stderr.write('Invalid code. Please make sure the full code was copied.\n');
      return;
    }
    if (code === 'bad') {
      process.stderr.write('Login failed: Token exchange failed\n');
      process.exit(1);
    }
    succeed();
  });
}
