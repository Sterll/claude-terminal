'use strict';

/**
 * Control Tower Tools Module for Claude Terminal MCP
 *
 * Provides visibility into active Claude sessions across all projects
 * and the ability to interrupt them.
 *
 * Data sources:
 *   - ~/.claude/projects/{encoded-path}/*.jsonl  — Claude session files (mtime = last activity)
 *   - CT_DATA_DIR/timetracking.json              — active project sessions
 *   - CT_DATA_DIR/projects.json                  — project names/paths
 *
 * Trigger files:
 *   - CT_DATA_DIR/terminal/triggers/interrupt_{ts}.json  — consumed by main process
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:control-tower] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || path.join(os.homedir(), '.claude-terminal');
}

function loadProjects() {
  const file = path.join(getDataDir(), 'projects.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading projects.json:', e.message);
  }
  return { projects: [] };
}

function loadTimeTracking() {
  const file = path.join(getDataDir(), 'timetracking.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading timetracking.json:', e.message);
  }
  return { version: 3, global: { sessions: [] }, projects: {} };
}

// -- Helpers ------------------------------------------------------------------

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatRelativeTime(ms) {
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  return `${Math.floor(ms / 3600000)}h ago`;
}

/**
 * Encode a project path the same way Claude does for its projects directory.
 * Claude encodes by replacing : \ / with -.
 */
function encodeProjectPath(projectPath) {
  return projectPath.replace(/:/g, '-').replace(/\\/g, '-').replace(/\//g, '-');
}

/**
 * Scan ~/.claude/projects/ for session files (*.jsonl) and return recent ones.
 * Returns: [{ projectPath, sessionId, mtimeMs, mtime }]
 */
function scanClaudeSessions(maxAgeMs = 3 * 60 * 60 * 1000) {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  const results = [];
  const now = Date.now();

  try {
    if (!fs.existsSync(claudeProjectsDir)) return results;
    const encodedPaths = fs.readdirSync(claudeProjectsDir);

    for (const encoded of encodedPaths) {
      const dirPath = path.join(claudeProjectsDir, encoded);
      try {
        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) continue;

        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const filePath = path.join(dirPath, file);
          try {
            const fileStat = fs.statSync(filePath);
            const ageMs = now - fileStat.mtimeMs;
            if (ageMs <= maxAgeMs) {
              results.push({
                encodedPath: encoded,
                sessionId: file.replace('.jsonl', ''),
                mtimeMs: fileStat.mtimeMs,
                ageMs,
              });
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (e) {
    log('Error scanning Claude sessions:', e.message);
  }

  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Try to match an encoded Claude path back to a known project.
 * Claude encodes like: C:\Users\foo\bar\project → C--Users-foo-bar-project
 */
function matchProjectByPath(encodedPath, projects) {
  for (const p of projects) {
    if (!p.path) continue;
    const encoded = encodeProjectPath(p.path);
    // Try exact match
    if (encoded === encodedPath) return p;
    // Try suffix match (encoded might start with leading dashes on Windows)
    const normalizedEncoded = encodedPath.replace(/^-+/, '');
    const normalizedProject = encoded.replace(/^-+/, '');
    if (normalizedEncoded === normalizedProject) return p;
    // Try basename match as fallback
    const projectBasename = path.basename(p.path);
    if (encodedPath.endsWith('-' + projectBasename) || encodedPath === projectBasename) return p;
  }
  return null;
}

/**
 * Get recently active projects from timetracking.json.
 * A project is "active" if it has a session that started recently
 * with no endTime (still running) or ended within the last 30 minutes.
 */
function getActiveFromTimeTracking(tt, maxAgeMs = 30 * 60 * 1000) {
  const now = Date.now();
  const active = new Map(); // projectId → { startTime, isRunning }

  for (const [pid, pdata] of Object.entries(tt.projects || {})) {
    const sessions = pdata.sessions || [];
    for (const s of sessions) {
      if (!s.startTime) continue;
      const startMs = new Date(s.startTime).getTime();
      const hasEnded = s.endTime || s.duration;

      if (!hasEnded) {
        // Session has no end time — still running
        active.set(pid, { startTime: s.startTime, isRunning: true });
        break;
      } else {
        // Session ended — check if recent
        const endMs = s.endTime
          ? new Date(s.endTime).getTime()
          : startMs + (s.duration || 0);
        if (now - endMs < maxAgeMs) {
          if (!active.has(pid)) {
            active.set(pid, { startTime: s.startTime, isRunning: false, endMs });
          }
        }
      }
    }
  }
  return active;
}

// -- Trigger files ------------------------------------------------------------

function writeTrigger(type, data) {
  const triggerDir = path.join(getDataDir(), 'terminal', 'triggers');
  if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

  const triggerFile = path.join(triggerDir, `${type}_${Date.now()}.json`);
  fs.writeFileSync(triggerFile, JSON.stringify({
    type,
    ...data,
    source: 'mcp',
    timestamp: new Date().toISOString(),
  }), 'utf8');
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'control_tower_agents',
    description: 'List all active or recently active Claude sessions across all projects. Shows project name, session age, path, and activity recency. Use this to see what Claude is currently doing across your workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        max_age_minutes: {
          type: 'number',
          description: 'Only show sessions active within the last N minutes (default: 60)',
        },
      },
    },
  },
  {
    name: 'control_tower_interrupt',
    description: 'Send an interrupt signal (Ctrl+C) to all running Claude terminals for a specific project. Useful to stop a long-running operation without killing the session.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name, ID, or path basename',
        },
      },
      required: ['project'],
    },
  },
];

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    // ── control_tower_agents ──
    if (name === 'control_tower_agents') {
      const maxAgeMinutes = args.max_age_minutes || 60;
      const maxAgeMs = maxAgeMinutes * 60 * 1000;
      const now = Date.now();

      const projData = loadProjects();
      const projects = projData.projects || [];
      const tt = loadTimeTracking();

      // 1. Scan Claude session files for recently modified ones
      const claudeSessions = scanClaudeSessions(maxAgeMs);

      // 2. Get active projects from time tracking
      const ttActive = getActiveFromTimeTracking(tt, maxAgeMs);

      // 3. Build unified list, deduplicating by project
      const seen = new Set(); // project IDs already listed
      const lines = [];

      // Primary: Claude session files (most accurate)
      for (const session of claudeSessions) {
        const project = matchProjectByPath(session.encodedPath, projects);
        const projectId = project?.id || session.encodedPath;
        const projectName = project?.name || path.basename(session.encodedPath.replace(/-/g, '/'));
        const projectPath = project?.path || `(encoded: ${session.encodedPath})`;

        const isVeryRecent = session.ageMs < 5 * 60 * 1000; // < 5 min
        const ttInfo = project ? ttActive.get(projectId) : null;
        const isRunning = ttInfo?.isRunning || isVeryRecent;

        const status = isRunning ? '● ACTIVE' : '○ RECENT';
        const age = formatRelativeTime(session.ageMs);
        const duration = ttInfo?.startTime
          ? formatDuration(now - new Date(ttInfo.startTime).getTime())
          : '';

        lines.push(
          `${status}  ${projectName}\n` +
          `  Path:    ${projectPath}\n` +
          `  Session: ${session.sessionId.slice(0, 16)}…  (last active: ${age})` +
          (duration ? `  running: ${duration}` : '') +
          `\n  ID: ${projectId}`
        );

        seen.add(projectId);
      }

      // Secondary: Time tracking active projects not already shown
      for (const [pid, info] of ttActive) {
        if (seen.has(pid)) continue;
        const project = projects.find(p => p.id === pid);
        if (!project) continue;

        const status = info.isRunning ? '● ACTIVE' : '○ RECENT';
        const duration = info.startTime
          ? formatDuration(now - new Date(info.startTime).getTime())
          : '';

        lines.push(
          `${status}  ${project.name || path.basename(project.path || pid)}\n` +
          `  Path:    ${project.path || '(unknown)'}\n` +
          `  Source:  time tracking` +
          (duration ? `  running: ${duration}` : '') +
          `\n  ID: ${pid}`
        );
      }

      if (lines.length === 0) {
        return ok(`No active or recent Claude sessions found in the last ${maxAgeMinutes} minutes.\n\nOpen a terminal or start a chat session in Claude Terminal to begin.`);
      }

      const activeCount = lines.filter(l => l.includes('● ACTIVE')).length;
      const totalCount = lines.length;

      let output = `# Control Tower — Active Agents\n`;
      output += `${activeCount} active, ${totalCount - activeCount} recent (last ${maxAgeMinutes}m)\n`;
      output += `${'─'.repeat(50)}\n\n`;
      output += lines.join('\n\n');

      return ok(output);
    }

    // ── control_tower_interrupt ──
    if (name === 'control_tower_interrupt') {
      if (!args.project) return fail('Missing required parameter: project');

      const projData = loadProjects();
      const project = (projData.projects || []).find(p =>
        p.id === args.project ||
        (p.name || '').toLowerCase() === args.project.toLowerCase() ||
        path.basename(p.path || '').toLowerCase() === args.project.toLowerCase()
      );

      if (!project) {
        const names = (projData.projects || []).map(p => p.name || path.basename(p.path || p.id));
        return fail(`Project "${args.project}" not found.\nAvailable projects: ${names.slice(0, 20).join(', ')}`);
      }

      writeTrigger('interrupt', {
        projectId: project.id,
        projectPath: project.path,
        projectName: project.name,
      });

      log(`Interrupt triggered for project: ${project.name || project.id}`);
      return ok(`Interrupt signal sent to "${project.name || path.basename(project.path || project.id)}".\nAll running Claude terminals for this project will receive Ctrl+C.`);
    }

    return fail(`Unknown control-tower tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Control Tower error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
