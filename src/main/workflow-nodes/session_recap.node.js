'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const readline = require('readline');

function resolveVars(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
    const parts = key.split('.');
    let cur = vars instanceof Map ? vars.get(parts[0]) : vars?.[parts[0]];
    for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
    return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
  });
}

// Same encoding as claude.ipc.js::encodeProjectPath
function encodeProjectPath(projectPath) {
  const MAX_LEN = 100;
  const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-').slice(0, MAX_LEN);
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash + projectPath.charCodeAt(i)) | 0;
  }
  return `${encoded}-${Math.abs(hash).toString(36)}`;
}

function projectsFile() {
  return path.join(os.homedir(), '.claude-terminal', 'projects.json');
}

function resolveProjectPath(ref, vars) {
  if (!ref) {
    const ctx = vars instanceof Map ? (vars.get('ctx') || {}) : (vars?.ctx || {});
    ref = ctx.activeProjectId || ctx.projectId || '';
  }
  if (!ref) return null;
  if (fs.existsSync(ref)) return ref;
  try {
    const data = JSON.parse(fs.readFileSync(projectsFile(), 'utf8'));
    const needle = String(ref).toLowerCase();
    const p = (data.projects || []).find(pr =>
      pr.id === ref || (pr.name || '').toLowerCase().includes(needle)
    );
    return p?.path || null;
  } catch {
    return null;
  }
}

async function resolveSessionFile(sessionsDir, sessionId) {
  const direct = path.join(sessionsDir, `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const p = path.join(sessionsDir, f);
      const content = fs.readFileSync(p, 'utf8').split('\n', 5);
      for (const line of content) {
        try {
          const obj = JSON.parse(line);
          if (obj.sessionId === sessionId) return p;
        } catch {}
      }
    }
  } catch {}
  return null;
}

async function extractRecapContext(filePath) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const prompts    = [];
    const toolCounts = {};
    let firstTs = null;
    let lastTs  = null;
    let toolCount = 0;

    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.timestamp) {
          const ts = new Date(obj.timestamp).getTime();
          if (!firstTs || ts < firstTs) firstTs = ts;
          if (!lastTs  || ts > lastTs)  lastTs  = ts;
        }
        // User prompts
        if (obj.type === 'user' && obj.message && !obj.isSidechain) {
          const content = obj.message.content;
          let text = '';
          if (typeof content === 'string') text = content;
          else if (Array.isArray(content)) {
            const t = content.find(b => b.type === 'text');
            if (t) text = t.text || '';
          }
          if (text && text.trim() && prompts.length < 10) {
            prompts.push(text.trim().slice(0, 300));
          }
        }
        // Tool uses
        if (obj.type === 'assistant' && obj.message?.content) {
          const blocks = Array.isArray(obj.message.content) ? obj.message.content : [];
          for (const b of blocks) {
            if (b.type === 'tool_use' && b.name) {
              toolCounts[b.name] = (toolCounts[b.name] || 0) + 1;
              toolCount++;
            }
          }
        }
      } catch {}
    });
    rl.on('close', () => {
      const durationMs = (firstTs && lastTs) ? Math.max(0, lastTs - firstTs) : 0;
      resolve({ prompts, toolCounts, toolCount, durationMs });
    });
    rl.on('error', () => resolve({ prompts: [], toolCounts: {}, toolCount: 0, durationMs: 0 }));
  });
}

module.exports = {
  type:     'workflow/session_recap',
  title:    'Session: Recap',
  desc:     'Génère un résumé IA (ou heuristique) d\'une session Claude',
  color:    'yellow',
  width:    240,
  category: 'data',
  icon:     'session',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',       type: 'exec'   },
    { name: 'Error',      type: 'exec'   },
    { name: 'summary',    type: 'string' },
    { name: 'source',     type: 'string' },
    { name: 'toolCount',  type: 'number' },
    { name: 'durationMs', type: 'number' },
  ],

  props: {
    projectId: '',
    sessionId: '',
    useAi:     true,
  },

  fields: [
    { type: 'cwd-picker', key: 'projectId', label: 'wfn.recap.project.label',
      hint: 'wfn.recap.project.hint' },
    { type: 'text',     key: 'sessionId', label: 'wfn.recap.sessionId.label',
      hint: 'wfn.recap.sessionId.hint',
      placeholder: '$ctx.sessionId' },
    { type: 'boolean',  key: 'useAi',     label: 'wfn.recap.useAi.label' },
  ],

  badge: () => '∑',

  async run(config, vars, signal) {
    if (signal?.aborted) throw new Error('Aborted');

    const projectPath = resolveProjectPath(resolveVars(config.projectId || '', vars), vars);
    if (!projectPath) throw new Error('Project path could not be resolved');

    let sessionId = resolveVars(config.sessionId || '', vars).trim();
    if (!sessionId) {
      const ctx = vars instanceof Map ? (vars.get('ctx') || {}) : (vars?.ctx || {});
      sessionId = ctx.sessionId || '';
    }
    if (!sessionId) throw new Error('sessionId is required (or $ctx.sessionId)');

    const sessionsDir = path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(projectPath));
    const filePath = await resolveSessionFile(sessionsDir, sessionId);
    if (!filePath) throw new Error(`Session file not found for ${sessionId}`);

    const ctx = await extractRecapContext(filePath);

    let githubToken = null;
    if (config.useAi !== false) {
      try {
        const GitHubAuthService = require('../services/GitHubAuthService');
        githubToken = await GitHubAuthService.getToken();
      } catch {}
    }

    const { generateSessionRecap } = require('../utils/commitMessageGenerator');
    const { summary, source } = await generateSessionRecap(ctx, githubToken);

    return {
      summary:    summary || '',
      source:     source  || 'heuristic',
      toolCount:  ctx.toolCount,
      durationMs: ctx.durationMs,
      prompts:    ctx.prompts,
    };
  },
};
