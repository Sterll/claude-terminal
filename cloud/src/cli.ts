#!/usr/bin/env node

import { store } from './store/store';
import { generateApiKey, hashApiKey } from './auth/auth';
import { config } from './config';
import readline from 'readline';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];
const param = args[2];

function printUsage(): void {
  console.log(`
  Claude Terminal Cloud - CLI Admin

  Usage:
    ct-cloud user add <name>          Create user and generate API key
    ct-cloud user setup <name>        Configure Claude auth + git identity for user
    ct-cloud user list                List all users with stats
    ct-cloud user remove <name>       Delete user and all their data
    ct-cloud user reset-key <name>    Regenerate API key for user

    ct-cloud status                   Server status
    ct-cloud start                    Start server (foreground)
    ct-cloud admin                    Interactive TUI dashboard

  `);
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${message} (y/N) `, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

async function userAdd(name: string): Promise<void> {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    console.error('Error: name must be alphanumeric (a-z, 0-9, _, -)');
    process.exit(1);
  }

  if (await store.userExists(name)) {
    console.error(`Error: user "${name}" already exists`);
    process.exit(1);
  }

  await store.ensureDataDirs();
  const apiKey = generateApiKey();
  await store.createUser(name, apiKey);

  console.log(`\n  User "${name}" created`);
  console.log(`  API Key: ${apiKey}`);
  console.log(`  Paste this key in Claude Terminal > Settings > Cloud`);
  console.log(`\n  Next: configure Claude auth + git for this user:`);
  console.log(`    ct-cloud user setup ${name}\n`);
}

async function userList(): Promise<void> {
  const users = await store.listUsers();
  if (users.length === 0) {
    console.log('\n  No users yet. Create one with: ct-cloud user add <name>\n');
    return;
  }

  console.log('');
  console.log('  NAME'.padEnd(18) + 'PROJECTS'.padEnd(12) + 'SESSIONS'.padEnd(14) + 'CLAUDE'.padEnd(10) + 'API KEY');
  console.log('  ' + '-'.repeat(66));

  for (const name of users) {
    const user = await store.getUser(name);
    if (!user) continue;
    const projectDirs = await store.listProjectDirs(name);
    const activeSessions = user.sessions.filter(s => s.status === 'running').length;
    const sessionStr = activeSessions > 0 ? `${activeSessions} active` : '0';
    const keyPreview = user.apiKeyHash ? user.apiKeyHash.slice(0, 12) : '(legacy)';
    const credPath = path.join(store.userHomePath(name), '.claude', '.credentials.json');
    let claudeStr = '✗';
    try { fs.accessSync(credPath); claudeStr = '✓'; } catch { /* not authed */ }

    console.log(
      `  ${user.name.padEnd(16)}${String(projectDirs.length).padEnd(12)}${sessionStr.padEnd(14)}${claudeStr.padEnd(10)}${keyPreview}...`
    );
  }
  console.log('');
}

async function userRemove(name: string): Promise<void> {
  if (!name) {
    console.error('Error: provide a user name');
    process.exit(1);
  }

  if (!(await store.userExists(name))) {
    console.error(`Error: user "${name}" does not exist`);
    process.exit(1);
  }

  const ok = await confirm(`  This will delete user "${name}" and all their projects. Continue?`);
  if (!ok) {
    console.log('  Cancelled.');
    return;
  }

  await store.deleteUser(name);
  console.log(`\n  User "${name}" removed\n`);
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function userSetup(name: string): Promise<void> {
  if (!name) {
    console.error('Error: provide a user name');
    process.exit(1);
  }

  const user = await store.getUser(name);
  if (!user) {
    console.error(`Error: user "${name}" does not exist`);
    process.exit(1);
  }

  await store.ensureUserHome(name);
  const userHome = store.userHomePath(name);

  console.log(`\n  Setting up user "${name}"...`);
  console.log(`  Home: ${userHome}\n`);

  // ── Git identity ──
  const currentGitName = user.gitName || '';
  const currentGitEmail = user.gitEmail || '';

  let gitName = await prompt(currentGitName ? `  Git name [${currentGitName}]: ` : '  Git name (e.g. John Doe): ');
  gitName = gitName || currentGitName;

  let gitEmail = await prompt(currentGitEmail ? `  Git email [${currentGitEmail}]: ` : '  Git email: ');
  gitEmail = gitEmail || currentGitEmail;

  if (gitName && gitEmail) {
    user.gitName = gitName;
    user.gitEmail = gitEmail;
    await store.saveUser(name, user);

    const gitconfigPath = path.join(userHome, '.gitconfig');
    fs.writeFileSync(gitconfigPath, `[user]\n\tname = ${gitName}\n\temail = ${gitEmail}\n`, 'utf-8');
    console.log(`  ✓ Git identity: ${gitName} <${gitEmail}>`);
  }

  // ── GitHub token ──
  console.log('');
  const gitCredsPath = path.join(userHome, '.git-credentials');
  const hasToken = fs.existsSync(gitCredsPath) && fs.readFileSync(gitCredsPath, 'utf-8').trim().length > 0;

  if (hasToken) {
    const update = await prompt('  Update GitHub token? (y/N): ');
    if (update.toLowerCase() !== 'y') {
      console.log('  ✓ GitHub token (unchanged)');
    } else {
      const token = await prompt('  GitHub token: ');
      if (token) {
        fs.writeFileSync(gitCredsPath, `https://oauth2:${token}@github.com\n`, { mode: 0o600 });
        // Set credential helper in gitconfig
        const gitconfigPath = path.join(userHome, '.gitconfig');
        let cfg = fs.existsSync(gitconfigPath) ? fs.readFileSync(gitconfigPath, 'utf-8') : '';
        if (!cfg.includes('[credential]')) {
          cfg += `[credential]\n\thelper = store --file ${gitCredsPath}\n`;
          fs.writeFileSync(gitconfigPath, cfg, 'utf-8');
        }
        console.log('  ✓ GitHub token saved');
      }
    }
  } else {
    console.log('  A GitHub token lets Claude push/pull on your repos.');
    console.log('  Create one at: https://github.com/settings/tokens');
    console.log('  Scopes needed: repo (Full control of private repositories)');
    console.log('');
    const token = await prompt('  GitHub token (press Enter to skip): ');
    if (token) {
      fs.writeFileSync(gitCredsPath, `https://oauth2:${token}@github.com\n`, { mode: 0o600 });
      const gitconfigPath = path.join(userHome, '.gitconfig');
      let cfg = fs.existsSync(gitconfigPath) ? fs.readFileSync(gitconfigPath, 'utf-8') : '';
      if (!cfg.includes('[credential]')) {
        cfg += `[credential]\n\thelper = store --file ${gitCredsPath}\n`;
        fs.writeFileSync(gitconfigPath, cfg, 'utf-8');
      }
      console.log('  ✓ GitHub token saved');
    } else {
      console.log('  Skipped');
    }
  }

  // ── Claude authentication ──
  console.log('');
  const credPath = path.join(userHome, '.claude', '.credentials.json');
  const hasCredentials = fs.existsSync(credPath);

  if (hasCredentials) {
    const reauth = await prompt('  Claude is already authenticated. Re-authenticate? (y/N): ');
    if (reauth.toLowerCase() !== 'y') {
      console.log('  ✓ Claude credentials (unchanged)');
      console.log(`\n  Setup complete for "${name}".\n`);
      return;
    }
  }

  console.log('  Starting Claude login...');
  console.log('  Follow the instructions below — a URL will appear to open in your browser.\n');

  try {
    execSync('claude login', {
      stdio: 'inherit',
      env: { ...process.env, HOME: userHome },
    });
  } catch {
    // Login may exit with non-zero on cancel
  }

  if (fs.existsSync(credPath)) {
    console.log('\n  ✓ Claude authenticated successfully');
  } else {
    console.log('\n  ✗ Authentication may have failed. Retry with:');
    console.log(`    docker exec -it ct-cloud node dist/cli.js user setup ${name}`);
  }

  console.log(`\n  Setup complete for "${name}".\n`);
}

async function userResetKey(name: string): Promise<void> {
  if (!name) {
    console.error('Error: provide a user name');
    process.exit(1);
  }

  const user = await store.getUser(name);
  if (!user) {
    console.error(`Error: user "${name}" does not exist`);
    process.exit(1);
  }

  const newKey = generateApiKey();
  user.apiKeyHash = hashApiKey(newKey);
  delete (user as any).apiKey; // Remove legacy plaintext if present
  await store.saveUser(name, user);

  console.log(`\n  API key for "${name}" regenerated`);
  console.log(`  New API Key: ${newKey}`);
  console.log(`  (this is shown only once)\n`);
}

async function status(): Promise<void> {
  const serverData = await store.getServerData();
  const users = await store.listUsers();

  console.log(`\n  Claude Terminal Cloud`);
  console.log(`  Port:     ${config.port}`);
  console.log(`  URL:      ${config.publicUrl}`);
  console.log(`  Cloud:    ${config.cloudEnabled ? 'enabled' : 'relay-only'}`);
  console.log(`  Users:    ${users.length}`);
  console.log(`  Since:    ${new Date(serverData.createdAt).toLocaleDateString()}`);
  console.log('');
}

async function startServer(): Promise<void> {
  // Dynamic import to avoid loading express/ws for CLI commands
  const { startServer: run } = await import('./index');
  await run();
}

async function main(): Promise<void> {
  try {
    if (command === 'user') {
      switch (subcommand) {
        case 'add': return await userAdd(param);
        case 'setup': return await userSetup(param);
        case 'list': return await userList();
        case 'remove': return await userRemove(param);
        case 'reset-key': return await userResetKey(param);
        default:
          printUsage();
          process.exit(1);
      }
    } else if (command === 'status') {
      return await status();
    } else if (command === 'start') {
      return await startServer();
    } else if (command === 'admin') {
      const { AdminTUI } = await import('./admin/AdminTUI');
      const tui = new AdminTUI();
      await tui.start();
      return;
    } else {
      printUsage();
      if (command) process.exit(1);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
