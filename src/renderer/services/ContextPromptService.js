/**
 * ContextPromptService
 * Manages context packs and prompt templates for the @context and @prompt mentions
 */

const { fs, path } = window.electron_nodeModules;
const { contextPacksFile, promptTemplatesFile } = require('../utils/paths');

// In-memory caches
let contextPacks = { global: [], projects: {} };
let promptTemplates = { global: [], projects: {} };

// ── Helpers ──

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Error reading ${filePath}:`, e);
    return null;
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Error writing ${filePath}:`, e);
  }
}

// ── Context Packs ──

function loadContextPacks() {
  const data = readJsonFile(contextPacksFile);
  if (data) {
    contextPacks = {
      global: Array.isArray(data.global) ? data.global : [],
      projects: data.projects || {}
    };
  }
  return contextPacks;
}

/**
 * Get all context packs (global + project-specific), with a scope label
 */
function getContextPacks(projectId) {
  const result = [];
  for (const pack of contextPacks.global) {
    result.push({ ...pack, scope: 'global' });
  }
  if (projectId && contextPacks.projects[projectId]) {
    for (const pack of contextPacks.projects[projectId]) {
      result.push({ ...pack, scope: 'project' });
    }
  }
  return result;
}

function getContextPack(id) {
  const found = contextPacks.global.find(p => p.id === id);
  if (found) return { ...found, scope: 'global' };
  for (const [projId, packs] of Object.entries(contextPacks.projects)) {
    const p = packs.find(pk => pk.id === id);
    if (p) return { ...p, scope: 'project', projectId: projId };
  }
  return null;
}

function saveContextPack(pack, projectId = null) {
  const now = Date.now();
  if (!pack.id) pack.id = generateId('ctx');
  pack.updatedAt = now;
  if (!pack.createdAt) pack.createdAt = now;

  const target = projectId ? (contextPacks.projects[projectId] || (contextPacks.projects[projectId] = [])) : contextPacks.global;
  const idx = target.findIndex(p => p.id === pack.id);
  if (idx >= 0) {
    target[idx] = pack;
  } else {
    target.push(pack);
  }
  writeJsonFile(contextPacksFile, contextPacks);
  return pack;
}

function deleteContextPack(id) {
  let idx = contextPacks.global.findIndex(p => p.id === id);
  if (idx >= 0) {
    contextPacks.global.splice(idx, 1);
    writeJsonFile(contextPacksFile, contextPacks);
    return true;
  }
  for (const packs of Object.values(contextPacks.projects)) {
    idx = packs.findIndex(p => p.id === id);
    if (idx >= 0) {
      packs.splice(idx, 1);
      writeJsonFile(contextPacksFile, contextPacks);
      return true;
    }
  }
  return false;
}

/**
 * Resolve a context pack to text content for injection
 */
async function resolveContextPack(id, projectPath) {
  const pack = getContextPack(id);
  if (!pack) return `[Context pack not found: ${id}]`;

  const parts = [`Context Pack: ${pack.name}`];
  if (pack.description) parts.push(pack.description);
  parts.push('');

  for (const item of (pack.items || [])) {
    try {
      switch (item.type) {
        case 'file': {
          const filePath = path.isAbsolute(item.path) ? item.path : path.join(projectPath || '', item.path);
          if (!fs.existsSync(filePath)) {
            parts.push(`[File not found: ${item.path}]`);
            break;
          }
          const raw = fs.readFileSync(filePath, 'utf8');
          const lines = raw.split('\n');
          if (lines.length > 500) {
            parts.push(`--- ${item.path} (first 500 of ${lines.length} lines) ---`);
            parts.push(lines.slice(0, 500).join('\n'));
          } else {
            parts.push(`--- ${item.path} ---`);
            parts.push(raw);
          }
          parts.push('');
          break;
        }
        case 'folder': {
          const folderPath = path.isAbsolute(item.path) ? item.path : path.join(projectPath || '', item.path);
          if (!fs.existsSync(folderPath)) {
            parts.push(`[Folder not found: ${item.path}]`);
            break;
          }
          const maxDepth = item.maxDepth || 2;
          const files = listFolderFiles(folderPath, maxDepth);
          parts.push(`--- ${item.path}/ (${files.length} files) ---`);
          for (const f of files.slice(0, 30)) {
            parts.push(`  ${f}`);
          }
          if (files.length > 30) parts.push(`  ... and ${files.length - 30} more`);
          parts.push('');
          break;
        }
        case 'text':
        case 'rule': {
          if (item.type === 'rule') {
            parts.push(`Rule: ${item.content}`);
          } else {
            parts.push(item.content);
          }
          parts.push('');
          break;
        }
      }
    } catch (e) {
      parts.push(`[Error resolving item: ${e.message}]`);
    }
  }

  // Cap total at 50000 chars
  let result = parts.join('\n');
  if (result.length > 50000) {
    result = result.slice(0, 50000) + '\n\n[Content truncated at 50,000 characters]';
  }
  return result;
}

function listFolderFiles(dirPath, maxDepth, currentDepth = 0) {
  if (currentDepth >= maxDepth) return [];
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.cache', 'coverage']);
  const results = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (ignoreDirs.has(entry.name)) continue;
      const rel = entry.name;
      if (entry.isDirectory()) {
        const sub = listFolderFiles(path.join(dirPath, entry.name), maxDepth, currentDepth + 1);
        for (const s of sub) results.push(`${rel}/${s}`);
      } else {
        results.push(rel);
      }
      if (results.length >= 200) break;
    }
  } catch (e) { /* ignore */ }
  return results;
}

// ── Prompt Templates ──

function loadPromptTemplates() {
  const data = readJsonFile(promptTemplatesFile);
  if (data) {
    promptTemplates = {
      global: Array.isArray(data.global) ? data.global : [],
      projects: data.projects || {}
    };
  }
  return promptTemplates;
}

function getPromptTemplates(projectId) {
  const result = [];
  for (const tmpl of promptTemplates.global) {
    result.push({ ...tmpl, scope: 'global' });
  }
  if (projectId && promptTemplates.projects[projectId]) {
    for (const tmpl of promptTemplates.projects[projectId]) {
      result.push({ ...tmpl, scope: 'project' });
    }
  }
  return result;
}

function getPromptTemplate(id) {
  const found = promptTemplates.global.find(p => p.id === id);
  if (found) return { ...found, scope: 'global' };
  for (const [projId, tmpls] of Object.entries(promptTemplates.projects)) {
    const t = tmpls.find(tm => tm.id === id);
    if (t) return { ...t, scope: 'project', projectId: projId };
  }
  return null;
}

function savePromptTemplate(template, projectId = null) {
  const now = Date.now();
  if (!template.id) template.id = generateId('prompt');
  template.updatedAt = now;
  if (!template.createdAt) template.createdAt = now;

  const target = projectId ? (promptTemplates.projects[projectId] || (promptTemplates.projects[projectId] = [])) : promptTemplates.global;
  const idx = target.findIndex(t => t.id === template.id);
  if (idx >= 0) {
    target[idx] = template;
  } else {
    target.push(template);
  }
  writeJsonFile(promptTemplatesFile, promptTemplates);
  return template;
}

function deletePromptTemplate(id) {
  let idx = promptTemplates.global.findIndex(t => t.id === id);
  if (idx >= 0) {
    promptTemplates.global.splice(idx, 1);
    writeJsonFile(promptTemplatesFile, promptTemplates);
    return true;
  }
  for (const tmpls of Object.values(promptTemplates.projects)) {
    idx = tmpls.findIndex(t => t.id === id);
    if (idx >= 0) {
      tmpls.splice(idx, 1);
      writeJsonFile(promptTemplatesFile, promptTemplates);
      return true;
    }
  }
  return false;
}

/**
 * Resolve prompt template variables and return the final text
 */
async function resolvePromptTemplate(id, project) {
  const tmpl = getPromptTemplate(id);
  if (!tmpl) return '[Prompt template not found]';

  let text = tmpl.template || '';
  const api = window.electron_api;

  // Sync variables
  text = text.replace(/\$projectName/g, project?.name || '[no project]');
  text = text.replace(/\$projectPath/g, project?.path || '[no project]');
  text = text.replace(/\$date/g, new Date().toLocaleDateString());
  text = text.replace(/\$time/g, new Date().toLocaleTimeString());

  // Async git variables (only resolve if present)
  if (text.includes('$branch') && project?.path) {
    try {
      const branch = await api.git.currentBranch({ projectPath: project.path });
      text = text.replace(/\$branch/g, branch || 'unknown');
    } catch {
      text = text.replace(/\$branch/g, '[no git branch]');
    }
  }

  if (text.includes('$lastCommit') && project?.path) {
    try {
      const log = await api.git.log({ projectPath: project.path, count: 1 });
      const last = log?.[0];
      text = text.replace(/\$lastCommit/g, last ? `${last.hash?.slice(0, 7)} ${last.message}` : '[no commits]');
    } catch {
      text = text.replace(/\$lastCommit/g, '[no git log]');
    }
  }

  if (text.includes('$changedFiles') && project?.path) {
    try {
      const status = await api.git.statusDetailed({ projectPath: project.path });
      const files = (status?.files || []).map(f => f.path).join('\n');
      text = text.replace(/\$changedFiles/g, files || '[no changes]');
    } catch {
      text = text.replace(/\$changedFiles/g, '[git status unavailable]');
    }
  }

  return text;
}

module.exports = {
  loadContextPacks,
  getContextPacks,
  getContextPack,
  saveContextPack,
  deleteContextPack,
  resolveContextPack,
  loadPromptTemplates,
  getPromptTemplates,
  getPromptTemplate,
  savePromptTemplate,
  deletePromptTemplate,
  resolvePromptTemplate
};
