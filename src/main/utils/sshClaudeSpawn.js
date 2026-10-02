/**
 * Claude chat sessions of remote (SSH) projects: the CLI runs on the host,
 * the Agent SDK runs here (design/remote-ssh.md section 5.2).
 *
 * `ChatService.startSession` keeps calling `sdk.query()` exactly as it does
 * for a local project and adds the SDK's `spawnClaudeCodeProcess` hook, which
 * this module builds. The hook ignores the command and cwd the SDK computed
 * (a local binary path and the local home directory) and spawns the system
 * ssh instead:
 *
 *   ssh -T -o BatchMode=yes <profile flags> -- <dest>
 *       /bin/sh -c <q("PATH=<login PATH>; export PATH;
 *                      cd -- <remotePath> && exec env <allowlist> <claude> <args>")>
 *
 * The SDK's stdio control protocol then rides ssh's stdin and stdout, so
 * permissions, interrupts, model switches, fork and rewind work unchanged. A
 * Node ChildProcess satisfies the SDK's SpawnedProcess interface as it is.
 *
 * What never crosses to the host:
 *   - the local environment. Only an allowlist of the variables the SDK sets
 *     for its child is forwarded, through `env` on the remote command line,
 *     never PATH, HOME, APPDATA, the config directories or anything shaped
 *     like a credential: a remote command line is visible to every user of
 *     the host through `ps`, and the remote CLI must use the remote login;
 *   - the local Claude in Chrome MCP server and the account overlay (both
 *     left out by ChatService for a remote session).
 *
 * `prepareRemoteChat` runs before any of that, in the chat IPC: it resolves
 * the project URI in main (the renderer never names a host), makes sure the
 * host is connected, and checks the handshake for a `claude` binary, so a
 * missing CLI is a sentence ("Claude Code is not installed on <host>") rather
 * than an exit code.
 */

'use strict';

const os = require('os');
const { spawn } = require('child_process');
const { q, qArgs, cdAnd, shC, withPath, classifySshFailure } = require('../../shared/remote-shell');
const sshCommand = require('./sshCommand');

/** Variables the SDK sets for the CLI it spawns, and the only ones a remote CLI receives. */
const ENV_ALLOWLIST = Object.freeze([
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS',
  'CLAUDE_AGENT_SDK_MCP_NO_PREFIX',
]);

/**
 * Never forwarded, whatever the allowlist says. Kept as a second check so a
 * later edit of the allowlist cannot ship a credential to a shared host.
 */
const ENV_DENY = new Set([
  'PATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
]);
const CREDENTIAL_SHAPED = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

/** Install command shown when the host has no `claude`. */
const INSTALL_HINT = 'curl -fsSL https://claude.ai/install.sh | bash';

function chatError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

/**
 * The `NAME=value` pairs a remote CLI receives, from the environment the SDK
 * built for its child.
 * @param {Record<string, string|undefined>} env
 * @returns {Array<[string, string]>}
 */
function remoteEnvPairs(env) {
  const pairs = [];
  for (const name of ENV_ALLOWLIST) {
    if (ENV_DENY.has(name) || CREDENTIAL_SHAPED.test(name)) continue;
    const value = env ? env[name] : undefined;
    if (typeof value !== 'string' || value === '') continue;
    if (/[\u0000-\u001f\u007f]/.test(value)) continue;
    pairs.push([name, value]);
  }
  return pairs;
}

/**
 * The CLI flags out of the SDK's argv. With the native binary the SDK passes
 * flags only; anything before the first flag (a script path, should the SDK
 * ever fall back to a JS entry point) names a local file and is dropped.
 * @param {string[]} args
 * @returns {string[]}
 */
function remoteClaudeArgs(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const first = list.findIndex((a) => a.startsWith('-'));
  return first === -1 ? [] : list.slice(first);
}

/**
 * The one-line script the remote `/bin/sh -c` runs.
 * @param {object} params
 * @param {string} params.remotePath  absolute POSIX path of the project
 * @param {string} params.claude      the remote claude binary
 * @param {string[]} params.args      CLI flags
 * @param {Record<string, string|undefined>} [params.env]  the SDK's child environment
 * @param {string|null} [params.loginPath]  the login PATH the handshake captured on the host
 * @returns {string}
 */
function buildRemoteChatScript({ remotePath, claude, args, env = {}, loginPath = null }) {
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/')) throw chatError('The remote project path must be absolute');
  if (typeof claude !== 'string' || !claude) throw chatError('No Claude Code binary to run on the remote host');
  const pairs = remoteEnvPairs(env);
  let argv;
  try {
    argv = qArgs([claude, ...args]);
  } catch {
    throw chatError('A Claude Code argument contains a control character and cannot be passed to the remote host');
  }
  const envPart = pairs.length ? `env ${pairs.map(([name, value]) => `${name}=${q(value)}`).join(' ')} ` : '';
  return withPath(loginPath, cdAnd(remotePath, `exec ${envPart}${argv}`));
}

/**
 * The SDK's `spawnClaudeCodeProcess` hook for one remote session.
 *
 * @param {object} params
 * @param {{command: string, prefixArgs?: string[], env?: object|null, profile: object, controlDir?: string|null, platform?: string}} params.launch
 *   from SshHostService.ptyLaunch: the ssh binary and the stored profile
 * @param {string} params.remotePath
 * @param {string} params.claude
 * @param {string|null} [params.loginPath]
 * @param {(text: string) => void} [params.onStderr]  the session's stderr sink
 * @param {Function} [params.spawnImpl]
 * @param {string} [params.homedir]  cwd of the local ssh process
 * @returns {(options: {command: string, args: string[], cwd?: string, env: object, signal?: AbortSignal}) => import('child_process').ChildProcess}
 */
function createRemoteSpawn({ launch, remotePath, claude, loginPath = null, onStderr = () => {}, spawnImpl = spawn, homedir = os.homedir() }) {
  if (!launch || !launch.command || !launch.profile) throw chatError('No ssh launch context for the remote session');
  return function spawnClaudeCodeProcess(options) {
    // options.command is a local binary and options.cwd the local home
    // directory: both describe this machine, so neither is used.
    const script = buildRemoteChatScript({
      remotePath,
      claude,
      args: remoteClaudeArgs(options && options.args),
      env: (options && options.env) || {},
      loginPath,
    });
    const sshArgs = sshCommand.chatArgs(launch.profile, shC(script), {
      platform: launch.platform || process.platform,
      controlDir: launch.controlDir || null,
    });
    const child = spawnImpl(launch.command, [...(launch.prefixArgs || []), ...sshArgs], {
      cwd: homedir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // The local ssh needs the local environment (SSH_AUTH_SOCK, the agent
      // pipe on Windows); none of it is sent to the host.
      env: launch.env || process.env,
      ...(options && options.signal ? { signal: options.signal } : {}),
    });
    // The SDK only wires its `stderr` option for its own local spawn.
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        try { onStderr(chunk.toString('utf8')); } catch { /* the sink is diagnostics only */ }
      });
    }
    return child;
  };
}

// ── CLI checks ───────────────────────────────────────────────────────────────

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * The Claude Code version the bundled SDK is built against, in the CLI's own
 * numbering (2.1.N). The platform package's version (`getSdkCliVersion`) is
 * the SDK's 0.3.N numbering, which a remote `claude --version` never prints.
 * @returns {string|null}
 */
function bundledCliVersion() {
  try {
    const pkg = require('@anthropic-ai/claude-agent-sdk/package.json');
    return typeof pkg.claudeCodeVersion === 'string' && pkg.claudeCodeVersion ? pkg.claudeCodeVersion : null;
  } catch {
    return null;
  }
}

/**
 * Whether the host can run a remote chat, from its handshake capabilities.
 * A missing CLI blocks; an older one only warns, naming both versions.
 *
 * @param {object|null} capabilities
 * @param {string|null} bundled  bundledCliVersion()
 * @returns {{ok: true, claude: string, warnings: Array<{code: string, remote: string, bundled: string}>} | {ok: false, code: 'not-installed'}}
 */
function checkRemoteCli(capabilities, bundled) {
  const claude = capabilities && typeof capabilities.claude === 'string' ? capabilities.claude : '';
  if (!claude) return { ok: false, code: 'not-installed' };
  const warnings = [];
  const remoteVersion = parseVersion(capabilities.claudeVersion);
  const bundledVersion = parseVersion(bundled);
  if (remoteVersion && bundledVersion && compareVersions(remoteVersion, bundledVersion) < 0) {
    warnings.push({ code: 'version-old', remote: remoteVersion.join('.'), bundled: bundledVersion.join('.') });
  }
  return { ok: true, claude, warnings };
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** ssh failure kinds after which the session can come back once the host does. */
const TRANSIENT_KINDS = new Set(['network', 'timeout', 'refused', 'dns']);

/**
 * A remote chat failure in English (main-process errors stay English).
 * @param {string} kind  a remote-shell SSH_FAILURE_KINDS value
 * @param {string} host
 * @returns {string|null}
 */
function describeSshFailure(kind, host) {
  const where = host || 'the remote host';
  switch (kind) {
    case 'not-installed': return `Claude Code is not installed on ${where}. Install it there (${INSTALL_HINT}), or set its path in the host profile.`;
    case 'auth': return `Authentication to ${where} failed. Remote chats need key or agent authentication: check the host profile, or connect once from a terminal tab.`;
    case 'hostkey-unknown': return `The host key of ${where} has not been verified yet. Use "Verify host" from the host badge, then try again.`;
    case 'hostkey-changed': return `The host key of ${where} has changed. The host may have been reinstalled, or someone may be intercepting the connection. Check it before connecting again.`;
    case 'dns': return `Could not resolve ${where}. Check the host name and your network.`;
    case 'timeout': return `The connection to ${where} timed out.`;
    case 'refused': return `${where} refused the SSH connection.`;
    case 'network': return `The connection to ${where} was lost.`;
    default: return null;
  }
}

/**
 * Classify why a remote chat process ended, from the SDK's error message and
 * the stderr the hook collected. Only ssh's own failure (exit 255) and the
 * remote shell's "command not found" (127) are ssh matters; any other exit is
 * the CLI's, and its stderr may well mention a refused or reset connection to
 * the API, which is not the ssh link.
 *
 * @param {string} message  the SDK error message
 * @param {string} stderr
 * @returns {string|null}
 */
function classifyRemoteChatFailure(message, stderr) {
  const text = String(message || '');
  const code = /exited with code (\d+)/.exec(text);
  if (code) {
    if (code[1] === '255') return classifySshFailure(255, stderr);
    if (code[1] === '127') return 'not-installed';
    return null;
  }
  // The pipe broke before an exit code was known: ssh's own diagnostics on
  // stderr are the only witness.
  if (/EPIPE|write after end|write EOF|not ready|terminated by signal/i.test(text)) {
    const kind = classifySshFailure(null, stderr);
    return kind && kind !== 'not-installed' ? kind : null;
  }
  return null;
}

/** Status states of SshHostService and what a chat start says about them. */
function describeHostState(state, host) {
  switch (state) {
    case 'authFailed': return { message: describeSshFailure('auth', host), errorType: 'generic' };
    case 'hostKeyUnknown': return { message: describeSshFailure('hostkey-unknown', host), errorType: 'generic' };
    case 'hostKeyChanged': return { message: describeSshFailure('hostkey-changed', host), errorType: 'generic' };
    case 'unsupported': return { message: `${host || 'The remote host'} cannot run remote sessions: see its host badge for why.`, errorType: 'generic' };
    default: return { message: `Not connected to ${host || 'the remote host'}. The chat starts once the host is reachable again.`, errorType: 'connection_lost' };
  }
}

/**
 * Everything a remote chat needs, resolved in main from the project URI.
 *
 * @param {object} params
 * @param {string} params.cwd         the project's ssh-remote:// path
 * @param {string|null} [params.projectId]
 * @param {object} [deps]             injectable for tests
 * @returns {Promise<{profileId: string, host: string, remotePath: string, projectId: string|null, launch: object, claude: string, loginPath: string|null, warnings: Array<object>}>}
 */
async function prepareRemoteChat({ cwd, projectId = null }, deps = defaultDeps()) {
  const target = await deps.resolveTarget(cwd);
  if (!target || target.kind !== 'remote') throw chatError('Not a remote project path');
  if (projectId && target.project && target.project.id && target.project.id !== projectId) {
    throw chatError('The chat project does not match its remote path');
  }
  const host = target.host || '';
  let status = deps.getStatus(target.profileId) || { state: 'idle' };
  if (status.state !== 'connected') status = (await deps.connect(target.profileId)) || status;
  if (!status || status.state !== 'connected') {
    const { message, errorType } = describeHostState(status && status.state, host);
    throw chatError(message, { errorType, code: 'REMOTE_CHAT_HOST' });
  }
  const launch = await deps.ptyLaunch(target.profileId);
  const capabilities = (launch && launch.capabilities) || status.capabilities || null;
  const check = checkRemoteCli(capabilities, deps.bundledVersion());
  if (!check.ok) throw chatError(describeSshFailure('not-installed', host), { code: 'CLAUDE_NOT_INSTALLED', errorType: 'generic' });
  return {
    profileId: target.profileId,
    host,
    remotePath: target.remotePath,
    projectId: (target.project && target.project.id) || projectId || null,
    launch,
    claude: check.claude,
    loginPath: (capabilities && capabilities.path) || null,
    warnings: check.warnings.map((w) => ({
      ...w,
      message: `Claude Code on ${host} is version ${w.remote}, older than the ${w.bundled} this app is built against. Some chat features may not work until it is updated there (claude update).`,
    })),
  };
}

function defaultDeps() {
  const sshHostService = require('../services/SshHostService');
  return {
    resolveTarget: (p) => require('./projectTarget').resolveTarget(p),
    getStatus: (id) => sshHostService.getStatus(id),
    connect: (id) => sshHostService.connect(id),
    ptyLaunch: (id) => sshHostService.ptyLaunch(id),
    bundledVersion: bundledCliVersion,
  };
}

module.exports = {
  ENV_ALLOWLIST,
  ENV_DENY,
  INSTALL_HINT,
  TRANSIENT_KINDS,
  remoteEnvPairs,
  remoteClaudeArgs,
  buildRemoteChatScript,
  createRemoteSpawn,
  bundledCliVersion,
  checkRemoteCli,
  describeSshFailure,
  describeHostState,
  classifyRemoteChatFailure,
  prepareRemoteChat,
};
