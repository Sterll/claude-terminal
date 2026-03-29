/**
 * Git display block renderers: commit cards, status overview, changelog, dependency info.
 */

const { escapeHtml } = require('../../../utils');

// ── Git Commit Card ──

function renderGitCommitBlock(code) {
  const lines = code.split('\n');
  let hash = '', message = '', author = '', date = '';
  let stats = { files: 0, add: 0, del: 0 };
  const files = [];
  let inFiles = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const hashMatch = trimmed.match(/^hash:\s*(.+)/i);
    if (hashMatch) { hash = hashMatch[1].trim(); continue; }
    const msgMatch = trimmed.match(/^message:\s*(.+)/i);
    if (msgMatch) { message = msgMatch[1].trim(); continue; }
    const authorMatch = trimmed.match(/^author:\s*(.+)/i);
    if (authorMatch) { author = authorMatch[1].trim(); continue; }
    const dateMatch = trimmed.match(/^date:\s*(.+)/i);
    if (dateMatch) { date = dateMatch[1].trim(); continue; }
    const statsMatch = trimmed.match(/^stats:\s*(.+)/i);
    if (statsMatch) {
      const parts = statsMatch[1].split(/[,\s]+/);
      for (const p of parts) {
        const filesM = p.match(/(\d+)\s*files?/i);
        if (filesM) stats.files = parseInt(filesM[1]);
        const addM = p.match(/\+(\d+)/);
        if (addM) stats.add = parseInt(addM[1]);
        const delM = p.match(/-(\d+)/);
        if (delM) stats.del = parseInt(delM[1]);
      }
      continue;
    }

    if (trimmed === '---') { inFiles = true; continue; }

    if (inFiles) {
      const fileParts = trimmed.split(/\s+/);
      if (fileParts.length >= 2) {
        files.push({ status: fileParts[0], path: fileParts.slice(1).join(' ') });
      }
    }
  }

  if (!hash && !message) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const shortHash = hash.length > 7 ? hash.slice(0, 7) : hash;
  const initial = author ? author[0].toUpperCase() : '?';

  const filesHtml = files.length > 0
    ? `<div class="chat-git-commit-files">${files.map(f => {
        const statusClass = escapeHtml(f.status.replace(/[^A-Z?]/gi, ''));
        const pathParts = f.path.replace(/\\/g, '/');
        const lastSlash = pathParts.lastIndexOf('/');
        const dir = lastSlash >= 0 ? pathParts.slice(0, lastSlash + 1) : '';
        const name = lastSlash >= 0 ? pathParts.slice(lastSlash + 1) : pathParts;
        return `<div class="chat-git-file-row">`
          + `<span class="chat-git-file-status ${statusClass}">${escapeHtml(f.status)}</span>`
          + `<span class="chat-git-file-path">${dir ? `<span class="dir">${escapeHtml(dir)}</span>` : ''}<span class="name">${escapeHtml(name)}</span></span>`
          + `</div>`;
      }).join('')}</div>`
    : '';

  const hasStats = stats.files || stats.add || stats.del;
  const statsHtml = hasStats
    ? `<div class="chat-git-commit-stats">`
      + `<span class="chat-git-stat-files">${stats.files} file${stats.files !== 1 ? 's' : ''}</span>`
      + (stats.add ? `<span class="chat-git-stat-add">+${stats.add}</span>` : '')
      + (stats.del ? `<span class="chat-git-stat-del">-${stats.del}</span>` : '')
      + `</div>`
    : '';

  return `<div class="chat-git-commit">`
    + `<div class="chat-git-commit-header">`
    + (shortHash ? `<span class="chat-git-commit-hash">${escapeHtml(shortHash)}</span>` : '')
    + `<span class="chat-git-commit-msg">${escapeHtml(message)}</span>`
    + `</div>`
    + `<div class="chat-git-commit-body">`
    + `<div class="chat-git-commit-meta">`
    + (author ? `<div class="chat-git-commit-author"><span class="chat-git-commit-avatar">${escapeHtml(initial)}</span><span>${escapeHtml(author)}</span></div>` : '')
    + (date ? `<div class="chat-git-commit-date">${escapeHtml(date)}</div>` : '')
    + `</div>`
    + filesHtml
    + statsHtml
    + `</div></div>`;
}

// ── Git Status ──

function renderGitStatusBlock(code) {
  const lines = code.split('\n');
  let branch = '', ahead = '', behind = '';
  const sections = {};
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const branchMatch = trimmed.match(/^branch:\s*(.+)/i);
    if (branchMatch) { branch = branchMatch[1].trim(); continue; }
    const aheadMatch = trimmed.match(/^ahead:\s*(\d+)/i);
    if (aheadMatch) { ahead = aheadMatch[1]; continue; }
    const behindMatch = trimmed.match(/^behind:\s*(\d+)/i);
    if (behindMatch) { behind = behindMatch[1]; continue; }

    // Section headers
    const sectionMatch = trimmed.match(/^(staged|modified|untracked|deleted|renamed|conflicted):/i);
    if (sectionMatch) { currentSection = sectionMatch[1].toLowerCase(); sections[currentSection] = []; continue; }

    // File entries under a section
    if (currentSection && sections[currentSection]) {
      const fileParts = trimmed.split(/\s+/);
      if (fileParts.length >= 2) {
        sections[currentSection].push({ status: fileParts[0], path: fileParts.slice(1).join(' ') });
      } else if (fileParts.length === 1) {
        // Untracked files may not have a status prefix
        const statusMap = { staged: 'A', modified: 'M', untracked: '?', deleted: 'D', renamed: 'R', conflicted: 'U' };
        sections[currentSection].push({ status: statusMap[currentSection] || '?', path: fileParts[0] });
      }
    }
  }

  if (!branch && Object.keys(sections).length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const aheadBehindHtml = (ahead || behind)
    ? `<span class="chat-git-ahead-behind">`
      + (ahead ? `<span class="chat-git-ahead">\u2191${escapeHtml(ahead)}</span>` : '')
      + (behind ? `<span class="chat-git-behind">\u2193${escapeHtml(behind)}</span>` : '')
      + `</span>`
    : '';

  const sectionNames = { staged: 'Staged', modified: 'Modified', untracked: 'Untracked', deleted: 'Deleted', renamed: 'Renamed', conflicted: 'Conflicted' };

  const sectionsHtml = Object.entries(sections).map(([key, files]) => {
    if (files.length === 0) return '';
    const label = sectionNames[key] || key;
    const filesHtml = files.map(f => {
      const statusClass = escapeHtml(f.status.replace(/[^A-Z?]/gi, ''));
      const pathParts = f.path.replace(/\\/g, '/');
      const lastSlash = pathParts.lastIndexOf('/');
      const dir = lastSlash >= 0 ? pathParts.slice(0, lastSlash + 1) : '';
      const name = lastSlash >= 0 ? pathParts.slice(lastSlash + 1) : pathParts;
      return `<div class="chat-git-status-file">`
        + `<span class="chat-git-file-status ${statusClass}">${escapeHtml(f.status)}</span>`
        + `<span class="chat-git-file-path">${dir ? `<span class="dir">${escapeHtml(dir)}</span>` : ''}<span class="name">${escapeHtml(name)}</span></span>`
        + `</div>`;
    }).join('');
    return `<div class="chat-git-status-section">`
      + `<div class="chat-git-status-section-title">${escapeHtml(label)} (${files.length})</div>`
      + filesHtml
      + `</div>`;
  }).join('');

  return `<div class="chat-git-status">`
    + `<div class="chat-git-status-header">`
    + `<span class="chat-git-branch-name"><span class="chat-git-branch-icon">\u2625</span>${escapeHtml(branch || 'unknown')}</span>`
    + aheadBehindHtml
    + `</div>`
    + sectionsHtml
    + `</div>`;
}

// ── Changelog ──

function renderChangelogBlock(code) {
  const lines = code.split('\n');
  let version = '', date = '', tag = '';
  const categories = [];
  let currentCat = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const versionMatch = trimmed.match(/^version:\s*(.+)/i);
    if (versionMatch) { version = versionMatch[1].trim(); continue; }
    const dateMatch = trimmed.match(/^date:\s*(.+)/i);
    if (dateMatch) { date = dateMatch[1].trim(); continue; }
    const tagMatch = trimmed.match(/^tag:\s*(.+)/i);
    if (tagMatch) { tag = tagMatch[1].trim(); continue; }

    // Category headers: feat:, fix:, perf:, breaking:, chore:, docs:, refactor:, test:
    const catMatch = trimmed.match(/^(feat|fix|perf|breaking|chore|docs|refactor|test|style):/i);
    if (catMatch) {
      currentCat = { type: catMatch[1].toLowerCase(), items: [] };
      categories.push(currentCat);
      continue;
    }

    // Items: lines starting with - or * or just plain text under a category
    if (currentCat) {
      const itemText = trimmed.replace(/^[-*]\s*/, '');
      // Parse optional scope: (scope) text or scope: text
      const scopeMatch = itemText.match(/^\(([^)]+)\)\s*(.+)/);
      const scopeMatch2 = itemText.match(/^([a-z-]+):\s*(.+)/i);
      if (scopeMatch) {
        currentCat.items.push({ text: scopeMatch[2], scope: scopeMatch[1] });
      } else if (scopeMatch2 && scopeMatch2[1].length < 20) {
        currentCat.items.push({ text: scopeMatch2[2], scope: scopeMatch2[1] });
      } else {
        currentCat.items.push({ text: itemText, scope: '' });
      }
    }
  }

  if (!version && categories.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const catLabels = {
    feat: 'Features', fix: 'Bug Fixes', perf: 'Performance', breaking: 'Breaking Changes',
    chore: 'Chores', docs: 'Documentation', refactor: 'Refactoring', test: 'Tests', style: 'Style'
  };

  const tagHtml = tag ? ` <span class="chat-changelog-tag">${escapeHtml(tag)}</span>` : '';

  const categoriesHtml = categories.map(cat => {
    const label = catLabels[cat.type] || cat.type;
    const itemsHtml = cat.items.map(item => {
      const scopeHtml = item.scope ? ` <span class="chat-changelog-scope">${escapeHtml(item.scope)}</span>` : '';
      return `<div class="chat-changelog-item"><span>${escapeHtml(item.text)}${scopeHtml}</span></div>`;
    }).join('');
    return `<div class="chat-changelog-category">`
      + `<div class="chat-changelog-cat-label ${escapeHtml(cat.type)}">${escapeHtml(label)}</div>`
      + itemsHtml
      + `</div>`;
  }).join('');

  return `<div class="chat-changelog">`
    + `<div class="chat-changelog-header">`
    + `<div class="chat-changelog-version">${escapeHtml(version || 'Unreleased')}${tagHtml}</div>`
    + (date ? `<div class="chat-changelog-date">${escapeHtml(date)}</div>` : '')
    + `</div>`
    + `<div class="chat-changelog-body">${categoriesHtml}</div>`
    + `</div>`;
}

// ── Dependency Info ──

function renderDependencyBlock(code) {
  const lines = code.split('\n');
  let name = '', current = '', latest = '', description = '', license = '', size = '', weekly = '', icon = '\uD83D\uDCE6';
  const deps = [];
  let inMulti = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Multi-dep mode: pipe-delimited rows
    if (trimmed.includes('|') && !trimmed.match(/^(name|version|current|latest|description|license|size|weekly|icon):/i)) {
      const parts = trimmed.split('|').map(s => s.trim());
      if (parts.length >= 2) {
        inMulti = true;
        deps.push({
          name: parts[0],
          current: parts[1],
          latest: parts[2] || '',
          description: parts[3] || '',
          license: parts[4] || '',
        });
      }
      continue;
    }

    const nameMatch = trimmed.match(/^name:\s*(.+)/i);
    if (nameMatch) { name = nameMatch[1].trim(); continue; }
    const currentMatch = trimmed.match(/^(?:current|version):\s*(.+)/i);
    if (currentMatch) { current = currentMatch[1].trim(); continue; }
    const latestMatch = trimmed.match(/^latest:\s*(.+)/i);
    if (latestMatch) { latest = latestMatch[1].trim(); continue; }
    const descMatch = trimmed.match(/^description:\s*(.+)/i);
    if (descMatch) { description = descMatch[1].trim(); continue; }
    const licenseMatch = trimmed.match(/^license:\s*(.+)/i);
    if (licenseMatch) { license = licenseMatch[1].trim(); continue; }
    const sizeMatch = trimmed.match(/^size:\s*(.+)/i);
    if (sizeMatch) { size = sizeMatch[1].trim(); continue; }
    const weeklyMatch = trimmed.match(/^weekly:\s*(.+)/i);
    if (weeklyMatch) { weekly = weeklyMatch[1].trim(); continue; }
    const iconMatch = trimmed.match(/^icon:\s*(.+)/i);
    if (iconMatch) { icon = iconMatch[1].trim(); continue; }
  }

  // Single dep mode
  if (!inMulti && name) {
    deps.push({ name, current, latest, description, license, size, weekly, icon });
  }

  if (deps.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  return deps.map(dep => {
    const depIcon = dep.icon || '\uD83D\uDCE6';
    const hasUpgrade = dep.latest && dep.latest !== dep.current;
    const versionHtml = hasUpgrade
      ? `<span class="chat-dep-version"><span class="current">${escapeHtml(dep.current)}</span><span class="arrow">\u2192</span><span class="latest">${escapeHtml(dep.latest)}</span></span>`
      : dep.current
        ? `<span class="chat-dep-version"><span class="latest">${escapeHtml(dep.current)}</span></span>`
        : '';

    const metaItems = [];
    if (dep.license) metaItems.push(`<div class="chat-dep-meta-item"><span class="chat-dep-license">${escapeHtml(dep.license)}</span></div>`);
    if (dep.size) metaItems.push(`<div class="chat-dep-meta-item"><span class="chat-dep-meta-label">Size:</span><span class="chat-dep-meta-value">${escapeHtml(dep.size)}</span></div>`);
    if (dep.weekly) metaItems.push(`<div class="chat-dep-meta-item"><span class="chat-dep-meta-label">Weekly:</span><span class="chat-dep-meta-value">${escapeHtml(dep.weekly)}</span></div>`);
    const metaHtml = metaItems.length > 0 ? `<div class="chat-dep-meta">${metaItems.join('')}</div>` : '';

    return `<div class="chat-dep-card">`
      + `<div class="chat-dep-header">`
      + `<div class="chat-dep-icon">${escapeHtml(depIcon)}</div>`
      + `<span class="chat-dep-name">${escapeHtml(dep.name)}</span>`
      + versionHtml
      + `</div>`
      + (dep.description || metaHtml ? `<div class="chat-dep-body">`
        + (dep.description ? `<div class="chat-dep-desc">${escapeHtml(dep.description)}</div>` : '')
        + metaHtml
        + `</div>` : '')
      + `</div>`;
  }).join('');
}

module.exports = {
  renderGitCommitBlock,
  renderGitStatusBlock,
  renderChangelogBlock,
  renderDependencyBlock,
};
