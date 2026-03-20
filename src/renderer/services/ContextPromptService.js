/**
 * ContextPromptService
 * Manages context packs and prompt templates for the @context and @prompt mentions
 */

const { BaseService } = require('../core/BaseService');
const { contextPacksFile, promptTemplatesFile } = require('../utils/paths');

class ContextPromptService extends BaseService {
  constructor(api, container) {
    super(api, container);
    this._contextPacks = { global: [], projects: {} };
    this._promptTemplates = { global: [], projects: {} };
  }

  // ── Context Packs ──

  loadContextPacks() {
    const data = this._readJsonFile(contextPacksFile);
    if (data) {
      this._contextPacks = {
        global: Array.isArray(data.global) ? data.global : [],
        projects: data.projects || {}
      };
    }
    return this._contextPacks;
  }

  getContextPacks(projectId) {
    const result = [];
    for (const pack of this._contextPacks.global) result.push({ ...pack, scope: 'global' });
    if (projectId && this._contextPacks.projects[projectId]) {
      for (const pack of this._contextPacks.projects[projectId]) result.push({ ...pack, scope: 'project' });
    }
    return result;
  }

  getContextPack(id) {
    const found = this._contextPacks.global.find(p => p.id === id);
    if (found) return { ...found, scope: 'global' };
    for (const [projId, packs] of Object.entries(this._contextPacks.projects)) {
      const p = packs.find(pk => pk.id === id);
      if (p) return { ...p, scope: 'project', projectId: projId };
    }
    return null;
  }

  saveContextPack(pack, projectId = null) {
    const now = Date.now();
    if (!pack.id) pack.id = _generateId('ctx');
    pack.updatedAt = now;
    if (!pack.createdAt) pack.createdAt = now;

    const target = projectId
      ? (this._contextPacks.projects[projectId] || (this._contextPacks.projects[projectId] = []))
      : this._contextPacks.global;
    const idx = target.findIndex(p => p.id === pack.id);
    if (idx >= 0) target[idx] = pack; else target.push(pack);
    this._writeJsonFile(contextPacksFile, this._contextPacks);
    return pack;
  }

  deleteContextPack(id) {
    let idx = this._contextPacks.global.findIndex(p => p.id === id);
    if (idx >= 0) {
      this._contextPacks.global.splice(idx, 1);
      this._writeJsonFile(contextPacksFile, this._contextPacks);
      return true;
    }
    for (const packs of Object.values(this._contextPacks.projects)) {
      idx = packs.findIndex(p => p.id === id);
      if (idx >= 0) {
        packs.splice(idx, 1);
        this._writeJsonFile(contextPacksFile, this._contextPacks);
        return true;
      }
    }
    return false;
  }

  async resolveContextPack(id, projectPath) {
    const pack = this.getContextPack(id);
    if (!pack) return `[Context pack not found: ${id}]`;

    const parts = [`Context Pack: ${pack.name}`];
    if (pack.description) parts.push(pack.description);
    parts.push('');

    for (const item of (pack.items || [])) {
      try {
        switch (item.type) {
          case 'file': {
            const filePath = this.api.path.isAbsolute(item.path) ? item.path : this.api.path.join(projectPath || '', item.path);
            if (!this.api.fs.existsSync(filePath)) { parts.push(`[File not found: ${item.path}]`); break; }
            const raw = this.api.fs.readFileSync(filePath, 'utf8');
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
            const folderPath = this.api.path.isAbsolute(item.path) ? item.path : this.api.path.join(projectPath || '', item.path);
            if (!this.api.fs.existsSync(folderPath)) { parts.push(`[Folder not found: ${item.path}]`); break; }
            const files = this._listFolderFiles(folderPath, item.maxDepth || 2);
            parts.push(`--- ${item.path}/ (${files.length} files) ---`);
            for (const f of files.slice(0, 30)) parts.push(`  ${f}`);
            if (files.length > 30) parts.push(`  ... and ${files.length - 30} more`);
            parts.push('');
            break;
          }
          case 'glob': {
            const { child_process } = window.electron_nodeModules;
            const baseDir = projectPath || '';
            try {
              const pattern = item.pattern || item.path || '**/*';
              const cmd = process.platform === 'win32'
                ? `git -C "${baseDir}" ls-files "${pattern}"`
                : `git -C '${baseDir}' ls-files '${pattern}'`;
              const output = child_process.execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000 });
              const files = output.trim().split('\n').filter(Boolean);
              parts.push(`--- Glob: ${pattern} (${files.length} files) ---`);
              let totalChars = 0;
              const maxChars = 40000;
              for (const relFile of files.slice(0, 50)) {
                const filePath = this.api.path.join(baseDir, relFile);
                try {
                  const content = this.api.fs.readFileSync(filePath, 'utf8');
                  if (totalChars + content.length > maxChars) { parts.push(`\n--- ${relFile} [skipped: size limit reached] ---`); continue; }
                  totalChars += content.length;
                  const lines = content.split('\n');
                  if (lines.length > 300) {
                    parts.push(`--- ${relFile} (first 300 of ${lines.length} lines) ---`);
                    parts.push(lines.slice(0, 300).join('\n'));
                  } else {
                    parts.push(`--- ${relFile} ---`);
                    parts.push(content);
                  }
                  parts.push('');
                } catch (e) { parts.push(`[Error reading ${relFile}: ${e.message}]`); }
              }
              if (files.length > 50) parts.push(`\n... and ${files.length - 50} more files`);
            } catch (e) { parts.push(`[Error resolving glob ${item.pattern || item.path}: ${e.message}]`); }
            parts.push('');
            break;
          }
          case 'text':
          case 'rule': {
            parts.push(item.type === 'rule' ? `Rule: ${item.content}` : item.content);
            parts.push('');
            break;
          }
        }
      } catch (e) { parts.push(`[Error resolving item: ${e.message}]`); }
    }

    let result = parts.join('\n');
    if (result.length > 50000) result = result.slice(0, 50000) + '\n\n[Content truncated at 50,000 characters]';
    return result;
  }

  async previewContextPack(id, projectPath) {
    const resolved = await this.resolveContextPack(id, projectPath);
    const lines = resolved.split('\n');
    const fileMatches = resolved.match(/^--- .+ ---$/gm) || [];
    return { content: resolved, stats: { chars: resolved.length, lines: lines.length, files: fileMatches.length } };
  }

  // ── Prompt Templates ──

  loadPromptTemplates() {
    const data = this._readJsonFile(promptTemplatesFile);
    if (data) {
      this._promptTemplates = {
        global: Array.isArray(data.global) ? data.global : [],
        projects: data.projects || {}
      };
    }
    return this._promptTemplates;
  }

  getPromptTemplates(projectId) {
    const result = [];
    for (const tmpl of this._promptTemplates.global) result.push({ ...tmpl, scope: 'global' });
    if (projectId && this._promptTemplates.projects[projectId]) {
      for (const tmpl of this._promptTemplates.projects[projectId]) result.push({ ...tmpl, scope: 'project' });
    }
    return result;
  }

  getPromptTemplate(id) {
    const found = this._promptTemplates.global.find(p => p.id === id);
    if (found) return { ...found, scope: 'global' };
    for (const [projId, tmpls] of Object.entries(this._promptTemplates.projects)) {
      const tmpl = tmpls.find(tm => tm.id === id);
      if (tmpl) return { ...tmpl, scope: 'project', projectId: projId };
    }
    return null;
  }

  savePromptTemplate(template, projectId = null) {
    const now = Date.now();
    if (!template.id) template.id = _generateId('prompt');
    template.updatedAt = now;
    if (!template.createdAt) template.createdAt = now;

    const target = projectId
      ? (this._promptTemplates.projects[projectId] || (this._promptTemplates.projects[projectId] = []))
      : this._promptTemplates.global;
    const idx = target.findIndex(t => t.id === template.id);
    if (idx >= 0) target[idx] = template; else target.push(template);
    this._writeJsonFile(promptTemplatesFile, this._promptTemplates);
    return template;
  }

  deletePromptTemplate(id) {
    let idx = this._promptTemplates.global.findIndex(t => t.id === id);
    if (idx >= 0) {
      this._promptTemplates.global.splice(idx, 1);
      this._writeJsonFile(promptTemplatesFile, this._promptTemplates);
      return true;
    }
    for (const tmpls of Object.values(this._promptTemplates.projects)) {
      idx = tmpls.findIndex(t => t.id === id);
      if (idx >= 0) {
        tmpls.splice(idx, 1);
        this._writeJsonFile(promptTemplatesFile, this._promptTemplates);
        return true;
      }
    }
    return false;
  }

  async resolvePromptTemplate(id, project) {
    const tmpl = this.getPromptTemplate(id);
    if (!tmpl) return '[Prompt template not found]';

    let text = tmpl.template || '';
    text = text.replace(/\$projectName/g, project?.name || '[no project]');
    text = text.replace(/\$projectPath/g, project?.path || '[no project]');
    text = text.replace(/\$date/g, new Date().toLocaleDateString());
    text = text.replace(/\$time/g, new Date().toLocaleTimeString());

    if (text.includes('$branch') && project?.path) {
      try { text = text.replace(/\$branch/g, await this.api.git.currentBranch({ projectPath: project.path }) || 'unknown'); }
      catch { text = text.replace(/\$branch/g, '[no git branch]'); }
    }
    if (text.includes('$lastCommit') && project?.path) {
      try {
        const log = await this.api.git.commitHistory({ projectPath: project.path, limit: 1 });
        const last = log?.[0];
        text = text.replace(/\$lastCommit/g, last ? `${last.hash?.slice(0, 7)} ${last.message}` : '[no commits]');
      } catch { text = text.replace(/\$lastCommit/g, '[no git log]'); }
    }
    if (text.includes('$changedFiles') && project?.path) {
      try {
        const status = await this.api.git.statusDetailed({ projectPath: project.path });
        text = text.replace(/\$changedFiles/g, (status?.files || []).map(f => f.path).join('\n') || '[no changes]');
      } catch { text = text.replace(/\$changedFiles/g, '[git status unavailable]'); }
    }
    return text;
  }

  // ── Private helpers ──

  _readJsonFile(filePath) {
    try {
      if (!this.api.fs.existsSync(filePath)) return null;
      const raw = this.api.fs.readFileSync(filePath, 'utf8');
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.error(`Error reading ${filePath}:`, e);
      return null;
    }
  }

  _writeJsonFile(filePath, data) {
    try { this.api.fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); }
    catch (e) { console.error(`Error writing ${filePath}:`, e); }
  }

  _listFolderFiles(dirPath, maxDepth, currentDepth = 0) {
    if (currentDepth >= maxDepth) return [];
    const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.cache', 'coverage']);
    const results = [];
    try {
      const entries = this.api.fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.isDirectory()) continue;
        if (ignoreDirs.has(entry.name)) continue;
        if (entry.isDirectory()) {
          const sub = this._listFolderFiles(this.api.path.join(dirPath, entry.name), maxDepth, currentDepth + 1);
          for (const s of sub) results.push(`${entry.name}/${s}`);
        } else {
          results.push(entry.name);
        }
        if (results.length >= 200) break;
      }
    } catch (e) { /* ignore */ }
    return results;
  }
}

function _generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Lazy singleton + legacy exports ──

let _instance = null;

function _getInstance() {
  if (!_instance) {
    const { getApiProvider, getContainer } = require('../core');
    _instance = new ContextPromptService(getApiProvider(), getContainer());
  }
  return _instance;
}

module.exports = {
  ContextPromptService,
  getInstance: _getInstance,
  loadContextPacks: (...a) => _getInstance().loadContextPacks(...a),
  getContextPacks: (...a) => _getInstance().getContextPacks(...a),
  getContextPack: (...a) => _getInstance().getContextPack(...a),
  saveContextPack: (...a) => _getInstance().saveContextPack(...a),
  deleteContextPack: (...a) => _getInstance().deleteContextPack(...a),
  resolveContextPack: (...a) => _getInstance().resolveContextPack(...a),
  previewContextPack: (...a) => _getInstance().previewContextPack(...a),
  loadPromptTemplates: (...a) => _getInstance().loadPromptTemplates(...a),
  getPromptTemplates: (...a) => _getInstance().getPromptTemplates(...a),
  getPromptTemplate: (...a) => _getInstance().getPromptTemplate(...a),
  savePromptTemplate: (...a) => _getInstance().savePromptTemplate(...a),
  deletePromptTemplate: (...a) => _getInstance().deletePromptTemplate(...a),
  resolvePromptTemplate: (...a) => _getInstance().resolvePromptTemplate(...a),
};
