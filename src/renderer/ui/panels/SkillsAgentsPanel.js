/**
 * SkillsAgentsPanel
 * Skills & Agents browsing, rendering, and management
 * Extracted from renderer.js
 */

const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { showConfirm } = require('../components/Modal');

let ctx = null;

let skillsAgentsState = {
  skills: [],
  agents: [],
  activeSubTab: 'local',
  initialized: false
};

let marketplaceSearchTimeout = null;

function init(context) {
  ctx = context;
}

async function loadSkills() {
  if (!skillsAgentsState.initialized) {
    skillsAgentsState.initialized = true;
    setupSkillsSubTabs();
  }

  if (skillsAgentsState.activeSubTab === 'local') {
    await loadLocalSkills();
  } else {
    await ctx.loadMarketplaceContent();
  }
}

async function loadLocalSkills() {
  skillsAgentsState.skills = [];
  try {
    await ctx.fs.promises.access(ctx.skillsDir);
    const items = await ctx.fs.promises.readdir(ctx.skillsDir);
    for (const item of items) {
      const itemPath = ctx.path.join(ctx.skillsDir, item);
      try {
        const stat = await ctx.fs.promises.stat(itemPath);
        if (stat.isDirectory()) {
          const skillFile = ctx.path.join(itemPath, 'SKILL.md');
          try {
            const content = await ctx.fs.promises.readFile(skillFile, 'utf8');
            const parsed = parseSkillMd(content);
            skillsAgentsState.skills.push({
              id: item,
              name: parsed.name || item,
              description: parsed.description || t('common.noDescription'),
              path: itemPath
            });
          } catch { /* SKILL.md not found, skip */ }
        }
      } catch { /* can't stat, skip */ }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error loading skills:', e);
  }
  renderSkills();
}

function setupSkillsSubTabs() {
  document.querySelectorAll('.skills-sub-tab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.skills-sub-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      skillsAgentsState.activeSubTab = btn.dataset.subtab;

      const newSkillBtn = document.getElementById('btn-new-skill');
      const searchContainer = document.getElementById('skills-marketplace-search');

      if (btn.dataset.subtab === 'local') {
        newSkillBtn.style.display = '';
        searchContainer.style.display = 'none';
      } else {
        newSkillBtn.style.display = 'none';
        searchContainer.style.display = 'flex';
      }

      loadSkills();
    };
  });

  // Setup marketplace search
  const input = document.getElementById('marketplace-search-input');
  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(marketplaceSearchTimeout);
      const query = input.value.trim();
      ctx.setMarketplaceSearchQuery(query);

      marketplaceSearchTimeout = setTimeout(() => {
        if (query.length >= 2) {
          ctx.searchMarketplace(query);
        } else if (query.length === 0) {
          ctx.loadMarketplaceFeatured();
        }
      }, 300);
    });
  }
}

function parseSkillMd(content) {
  let name = null;
  let description = null;

  const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (yamlMatch) {
    const yaml = yamlMatch[1];
    const descMatch = yaml.match(/description\s*:\s*["']?(.+?)["']?\s*$/m);
    if (descMatch) description = descMatch[1].trim();
    const nameMatch = yaml.match(/name\s*:\s*["']?(.+?)["']?\s*$/m);
    if (nameMatch) name = nameMatch[1].trim();
  }

  const titleMatch = content.match(/^#\s+(.+)/m);
  if (titleMatch && !name) {
    name = titleMatch[1].trim();
  }

  if (!description) {
    let body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
    const afterTitle = body.replace(/^#\s+.+\n/, '');
    const untilNextSection = afterTitle.split(/\n##\s/)[0];
    const paragraphs = untilNextSection.split(/\n\n+/);
    for (const p of paragraphs) {
      const cleaned = p.trim();
      if (cleaned && !cleaned.startsWith('#') && !cleaned.startsWith('```') && cleaned.length > 10) {
        description = cleaned.split('\n')[0].trim();
        break;
      }
    }
  }

  return { name, description };
}

async function loadAgents() {
  skillsAgentsState.agents = [];
  try {
    await ctx.fs.promises.access(ctx.agentsDir);
    const items = await ctx.fs.promises.readdir(ctx.agentsDir);
    for (const item of items) {
      const itemPath = ctx.path.join(ctx.agentsDir, item);
      try {
        const stat = await ctx.fs.promises.stat(itemPath);

        if (stat.isFile() && item.endsWith('.md')) {
          const content = await ctx.fs.promises.readFile(itemPath, 'utf8');
          const parsed = parseAgentMd(content);
          const id = item.replace(/\.md$/, '');
          skillsAgentsState.agents.push({
            id,
            name: parsed.name || id,
            description: parsed.description || 'Aucune description',
            tools: parsed.tools || [],
            path: itemPath
          });
        } else if (stat.isDirectory()) {
          const agentFile = ctx.path.join(itemPath, 'AGENT.md');
          try {
            const content = await ctx.fs.promises.readFile(agentFile, 'utf8');
            const parsed = parseAgentMd(content);
            skillsAgentsState.agents.push({
              id: item,
              name: parsed.name || item,
              description: parsed.description || t('common.noDescription'),
              tools: parsed.tools || [],
              path: itemPath
            });
          } catch { /* AGENT.md not found, skip */ }
        }
      } catch { /* can't stat, skip */ }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error loading agents:', e);
  }
  renderAgents();
}

function parseAgentMd(content) {
  let name = null;
  let description = null;
  let tools = [];

  const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (yamlMatch) {
    const yaml = yamlMatch[1];
    const descMatch = yaml.match(/description\s*:\s*["']?(.+?)["']?\s*$/m);
    if (descMatch) description = descMatch[1].trim();
    const nameMatch = yaml.match(/name\s*:\s*["']?(.+?)["']?\s*$/m);
    if (nameMatch) name = nameMatch[1].trim();
    const toolsMatch = yaml.match(/tools\s*:\s*\[([^\]]+)\]/);
    if (toolsMatch) tools = toolsMatch[1].split(',').map(t => t.trim().replace(/["']/g, ''));
  }

  const titleMatch = content.match(/^#\s+(.+)/m);
  if (titleMatch && !name) {
    name = titleMatch[1].trim();
  }

  if (!description) {
    const descInBody = content.match(/description\s*:\s*["']([^"']+)["']/i) ||
                       content.match(/description\s*:\s*(.+)$/im);
    if (descInBody) {
      description = descInBody[1].trim().replace(/^["']|["']$/g, '');
    }
  }

  if (tools.length === 0) {
    const toolsInBody = content.match(/tools\s*:\s*\[([^\]]+)\]/i);
    if (toolsInBody) {
      tools = toolsInBody[1].split(',').map(t => t.trim().replace(/["']/g, ''));
    }
  }

  if (!description) {
    let body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
    const afterTitle = body.replace(/^#\s+.+\n/, '');
    const untilNextSection = afterTitle.split(/\n##\s/)[0];
    const paragraphs = untilNextSection.split(/\n\n+/);
    for (const p of paragraphs) {
      const cleaned = p.trim();
      if (cleaned &&
          !cleaned.startsWith('#') &&
          !cleaned.startsWith('```') &&
          !cleaned.match(/^\w+\s*:/) &&
          cleaned.length > 10) {
        description = cleaned.split('\n')[0].trim();
        break;
      }
    }
  }

  return { name, description, tools };
}

function renderSkills() {
  const list = document.getElementById('skills-list');
  if (skillsAgentsState.skills.length === 0) {
    list.innerHTML = `<div class="empty-list"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg><h3>${t('skillsAgents.noSkills')}</h3><p>${t('skillsAgents.createFirstSkill')}</p></div>`;
    return;
  }

  const localSkills = skillsAgentsState.skills.filter(s => !s.isPlugin);
  const pluginSkills = skillsAgentsState.skills.filter(s => s.isPlugin);

  const pluginsBySource = {};
  pluginSkills.forEach(s => {
    if (!pluginsBySource[s.sourceLabel]) pluginsBySource[s.sourceLabel] = [];
    pluginsBySource[s.sourceLabel].push(s);
  });

  let html = '';

  if (localSkills.length > 0) {
    html += `<div class="list-section">
      <div class="list-section-title">${t('skillsAgents.local')} <span class="list-section-count">${localSkills.length}</span></div>
      <div class="list-section-grid">`;
    html += localSkills.map(s => {
      const desc = (s.description && s.description !== '---' && s.description !== t('common.noDescription')) ? escapeHtml(s.description) : '';
      const initial = escapeHtml((s.name || '?').charAt(0).toUpperCase());
      return `
      <div class="list-card" data-path="${s.path.replace(/"/g, '&quot;')}" data-is-plugin="false">
        <div class="card-initial">${initial}</div>
        <div class="list-card-header">
          <div class="list-card-title">${escapeHtml(s.name)}</div>
          <div class="list-card-badge">${t('skillsAgents.skill')}</div>
        </div>
        ${desc ? `<div class="list-card-desc">${desc}</div>` : ''}
        <div class="list-card-footer">
          <button class="btn-sm btn-secondary btn-open">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            ${t('marketplace.openFolder')}
          </button>
          <button class="btn-sm btn-delete btn-del" title="${t('common.delete')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
    html += `</div></div>`;
  }

  Object.entries(pluginsBySource).forEach(([source, skills]) => {
    html += `<div class="list-section">
      <div class="list-section-title"><span class="plugin-badge">Plugin</span> ${escapeHtml(source)} <span class="list-section-count">${skills.length}</span></div>
      <div class="list-section-grid">`;
    html += skills.map(s => {
      const desc = (s.description && s.description !== '---' && s.description !== t('common.noDescription')) ? escapeHtml(s.description) : '';
      const initial = escapeHtml((s.name || '?').charAt(0).toUpperCase());
      return `
      <div class="list-card plugin-card" data-path="${s.path.replace(/"/g, '&quot;')}" data-is-plugin="true">
        <div class="card-initial">${initial}</div>
        <div class="list-card-header">
          <div class="list-card-title">${escapeHtml(s.name)}</div>
          <div class="list-card-badge plugin">Plugin</div>
        </div>
        ${desc ? `<div class="list-card-desc">${desc}</div>` : ''}
        <div class="list-card-footer">
          <button class="btn-sm btn-secondary btn-open">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            ${t('marketplace.openFolder')}
          </button>
        </div>
      </div>`;
    }).join('');
    html += `</div></div>`;
  });

  list.innerHTML = html;

  list.querySelectorAll('.list-card').forEach(card => {
    card.querySelector('.btn-open').onclick = () => ctx.api.dialog.openInExplorer(card.dataset.path);
    const delBtn = card.querySelector('.btn-del');
    if (delBtn) {
      delBtn.onclick = async () => {
        const ok = await showConfirm({ title: t('skillsAgents.deleteSkill') || 'Delete skill', message: t('skillsAgents.confirmDeleteSkill'), confirmLabel: t('common.delete'), danger: true });
        if (ok) { await ctx.fs.promises.rm(card.dataset.path, { recursive: true, force: true }); loadSkills(); }
      };
    }
  });
}

function renderAgents() {
  const list = document.getElementById('agents-list');
  if (skillsAgentsState.agents.length === 0) {
    list.innerHTML = `<div class="empty-list"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM8 17.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5zM9.5 8c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5S9.5 9.38 9.5 8zm6.5 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg><h3>${t('skillsAgents.noAgents')}</h3><p>${t('skillsAgents.createFirstAgent')}</p></div>`;
    return;
  }

  let html = `<div class="list-section">
    <div class="list-section-title">${t('skillsAgents.agents')} <span class="list-section-count">${skillsAgentsState.agents.length}</span></div>
    <div class="list-section-grid">`;
  html += skillsAgentsState.agents.map(a => {
    const desc = (a.description && a.description !== '---' && a.description !== t('common.noDescription')) ? escapeHtml(a.description) : '';
    const initial = escapeHtml((a.name || '?').charAt(0).toUpperCase());
    return `
    <div class="list-card agent-card" data-path="${a.path.replace(/"/g, '&quot;')}">
      <div class="card-initial">${initial}</div>
      <div class="list-card-header">
        <div class="list-card-title">${escapeHtml(a.name)}</div>
        <div class="list-card-badge agent">${t('skillsAgents.agent')}</div>
      </div>
      ${desc ? `<div class="list-card-desc">${desc}</div>` : ''}
      <div class="list-card-footer">
        <button class="btn-sm btn-secondary btn-open">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
          ${t('marketplace.openFolder')}
        </button>
        <button class="btn-sm btn-delete btn-del" title="${t('common.delete')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
  html += `</div></div>`;

  list.innerHTML = html;

  list.querySelectorAll('.list-card').forEach(card => {
    card.querySelector('.btn-open').onclick = () => ctx.api.dialog.openInExplorer(card.dataset.path);
    card.querySelector('.btn-del').onclick = async () => {
      const ok = await showConfirm({ title: t('skillsAgents.deleteAgent') || 'Delete agent', message: t('skillsAgents.confirmDeleteAgent'), confirmLabel: t('common.delete'), danger: true });
      if (ok) { await ctx.fs.promises.rm(card.dataset.path, { recursive: true, force: true }); loadAgents(); }
    };
  });
}

module.exports = { init, loadSkills, loadAgents };
