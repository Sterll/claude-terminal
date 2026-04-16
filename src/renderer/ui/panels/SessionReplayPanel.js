/**
 * Session Replay Panel
 * Interactive audit trail: replay any Claude session as a chronological timeline
 * of tool calls, file edits, prompts, and estimated token usage.
 */

const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

let container = null;
let projectsState = null;

// ── Panel state ───────────────────────────────────────────────────────────────
let currentProjectPath = null;
let currentSessionId = null;
let currentSteps = [];
let currentSummary = {};
let selectedStepIndex = -1;
let allSessions = []; // All sessions for current project (for branch filtering)
let currentBranchFilter = ''; // '' = all branches

// ── Player state ───────────────────────────────────────────────────────────────
let playerSteps = [];
let playerCurrentStep = -1;
let playerIsPlaying = false;
let playerSpeed = 1;
let playerTimer = null;
let _playerDragCleanup = null;
let currentView = 'timeline'; // 'timeline' | 'player'

// ── DOM refs ──────────────────────────────────────────────────────────────────
let projectSelect = null;
let branchSelect = null;
let sessionSelect = null;
let loadBtn = null;
let summaryBar = null;
let viewToggleEl = null;
let timeline = null;
let playerChatEl = null;
let playerBarEl = null;

// ── Tool category helpers ─────────────────────────────────────────────────────
const TOOL_CATEGORIES = {
  file:    ['Read', 'Write', 'Edit', 'NotebookEdit'],
  terminal:['Bash'],
  search:  ['Glob', 'Grep'],
  web:     ['WebFetch', 'WebSearch'],
  agent:   ['Task'],
  plan:    ['ExitPlanMode', 'AskUserQuestion', 'EnterPlanMode', 'TodoWrite'],
};

// Player speed → ms/step
const PLAYER_SPEED_DELAYS = { 0.5: 2000, 1: 1000, 2: 500, 4: 250 };

// Tool category → RGB for chat-style border-left
const CAT_COLORS = {
  file:     '34,197,94',
  terminal: '245,158,11',
  search:   '167,139,250',
  web:      '6,182,212',
  agent:    '249,115,22',
  plan:     '217,119,6',
  other:    '100,100,110',
};

// Tools that have a friendly card renderer (Fix 4)
const FRIENDLY_TOOLS = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit',
  'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'AskUserQuestion', 'Task', 'TodoWrite',
]);

function getToolCategory(toolName) {
  for (const [cat, tools] of Object.entries(TOOL_CATEGORIES)) {
    if (tools.includes(toolName)) return cat;
  }
  return 'other';
}

function getToolIcon(toolName) {
  const cat = getToolCategory(toolName);
  switch (cat) {
    case 'file': return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>`;
    case 'terminal': return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10zM6 10h2v2H6zm0 4h8v2H6zm10 0h2v2h-2zm-6-4h8v2h-8z"/></svg>`;
    case 'search': return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>`;
    case 'web': return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>`;
    case 'agent': return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2.05v2.02c3.95.49 7 3.85 7 7.93s-3.05 7.44-7 7.93v2.02c5.05-.5 9-4.76 9-9.95S18.05 2.55 13 2.05zM11 2.05C5.95 2.55 2 6.81 2 12s3.95 9.45 9 9.95v-2.02C7.05 19.44 4 16.08 4 12s3.05-7.44 7-7.93V2.05zM12 6l-5 5h3v6h4v-6h3z"/></svg>`;
    case 'plan': return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>`;
    default: return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17.93V18c0-.55-.45-1-1-1s-1 .45-1 1v1.93C7.06 19.44 4.56 16.94 4.07 14H6c.55 0 1-.45 1-1s-.45-1-1-1H4.07C4.56 8.06 7.06 5.56 11 5.07V7c0 .55.45 1 1 1s1-.45 1-1V5.07C16.94 5.56 19.44 8.06 19.93 11H18c-.55 0-1 .45-1 1s.45 1 1 1h1.93c-.49 3.94-2.99 6.44-6.93 6.93z"/></svg>`;
  }
}

function getStepIcon(step) {
  if (step.type === 'prompt') {
    return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>`;
  }
  if (step.type === 'response') {
    return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>`;
  }
  if (step.type === 'thinking') {
    return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.5 2C6.81 2 3 5.81 3 10.5S6.81 19 11.5 19h.5v3c4.86-2.34 8-7 8-11.5C20 5.81 16.19 2 11.5 2zm1 14.5h-2v-2h2v2zm0-4h-2c0-3.25 3-3 3-5 0-1.1-.9-2-2-2s-2 .9-2 2h-2c0-2.21 1.79-4 4-4s4 1.79 4 4c0 2.5-3 2.75-3 5z"/></svg>`;
  }
  return getToolIcon(step.toolName);
}

function formatTokens(n) {
  if (n >= 1000) return `~${(n / 1000).toFixed(1)}k tok`;
  return `~${n} tok`;
}

function getStepTokens(step) {
  if (step.type === 'tool') {
    return (step.estimatedInputTokens || 0) + (step.estimatedOutputTokens || 0);
  }
  return step.estimatedTokens || 0;
}

function truncate(str, max = 120) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max) + '…';
}

// ── Fix 3: Skill detection ────────────────────────────────────────────────────
/**
 * Returns { hasSkill: true, skillName: string, rest: string } if prompt starts
 * with or contains a slash-command skill reference, else { hasSkill: false }.
 * A skill reference is /word at the start or in the body of the text.
 */
function detectSkillInPrompt(text) {
  if (!text) return { hasSkill: false };
  // Detect <command-name>/skill-name</command-name> XML format (Skill tool invocation)
  const cmdNameMatch = text.match(/<command-name>(\/[\w-]+)<\/command-name>/);
  if (cmdNameMatch) {
    return { hasSkill: true, skillName: cmdNameMatch[1], rest: '' };
  }
  // Match /skill-name at start or after whitespace, capturing word chars and dashes
  const match = text.match(/(?:^|\n)\s*(\/[\w-]+)/);
  if (!match) return { hasSkill: false };
  const skillName = match[1];
  // The "rest" is what remains after removing the skill invocation line(s)
  const rest = text.replace(match[0], '').trim();
  return { hasSkill: true, skillName, rest };
}

// ── Fix 2: Group consecutive identical tool calls ─────────────────────────────
/**
 * Merges runs of consecutive steps that call the same tool into a single "group"
 * step. Returns a new array where each element is either a normal step or a
 * group step ({ type: 'group', toolName, steps[], count }).
 */
function groupConsecutiveAgents(steps) {
  const grouped = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    // Only group tool steps (not prompt/response/thinking)
    if (step.type !== 'tool') {
      grouped.push(step);
      i++;
      continue;
    }
    // Look ahead for consecutive identical tool calls
    let j = i + 1;
    while (
      j < steps.length &&
      steps[j].type === 'tool' &&
      steps[j].toolName === step.toolName
    ) {
      j++;
    }
    const runLength = j - i;
    if (runLength >= 3) {
      // Collapse into a group
      grouped.push({
        type: 'group',
        toolName: step.toolName,
        count: runLength,
        steps: steps.slice(i, j),
        // Carry tokens and category from first
        estimatedInputTokens: steps.slice(i, j).reduce((s, x) => s + (x.estimatedInputTokens || 0), 0),
        estimatedOutputTokens: steps.slice(i, j).reduce((s, x) => s + (x.estimatedOutputTokens || 0), 0),
      });
      i = j;
    } else {
      grouped.push(step);
      i++;
    }
  }
  return grouped;
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderSummary(summary) {
  if (!summary || !summary.totalSteps) {
    summaryBar.innerHTML = '';
    return;
  }
  const topTools = Object.entries(summary.toolBreakdown || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => `<span class="sr-badge sr-badge--tool">${escapeHtml(name)} <strong>${count}</strong></span>`)
    .join('');

  summaryBar.innerHTML = `
    <div class="sr-summary-items">
      <span class="sr-summary-item">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z"/></svg>
        <strong>${summary.totalSteps}</strong> ${t('sessionReplay.steps')}
      </span>
      <span class="sr-summary-item">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/></svg>
        <strong>${formatTokens(summary.totalEstimatedTokens)}</strong> ${t('sessionReplay.estimated')}
      </span>
      ${summary.uniqueFileCount > 0 ? `
      <span class="sr-summary-item">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>
        <strong>${summary.uniqueFileCount}</strong> ${t('sessionReplay.files')}
      </span>` : ''}
      ${topTools ? `<span class="sr-summary-sep">·</span>${topTools}` : ''}
    </div>`;
}

function renderTimeline(steps) {
  if (!steps || steps.length === 0) {
    timeline.innerHTML = `<div class="sr-empty">${t('sessionReplay.noSteps')}</div>`;
    return;
  }

  // Fix 2: group consecutive identical tool calls
  const displaySteps = groupConsecutiveAgents(steps);

  timeline.innerHTML = displaySteps.map((step, i) => {
    if (step.type === 'group') {
      return renderGroupStep(step, i);
    }
    return renderNormalStep(step, i);
  }).join('');

  // Attach click handlers for normal steps
  timeline.querySelectorAll('.sr-step:not(.sr-step--grouped)').forEach(el => {
    el.addEventListener('click', () => toggleStep(el));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleStep(el); }
      if (e.key === 'ArrowDown') { e.preventDefault(); focusStep(+el.dataset.stepIndex + 1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); focusStep(+el.dataset.stepIndex - 1); }
    });
  });

  // Attach click handlers for grouped steps (toggle accordion)
  timeline.querySelectorAll('.sr-step--grouped').forEach(el => {
    el.addEventListener('click', () => toggleGroupStep(el));
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroupStep(el); }
    });
  });
}

function renderNormalStep(step, i) {
  const tokens = getStepTokens(step);
  const cat = step.type === 'tool' ? getToolCategory(step.toolName) : step.type;
  const subtitle = buildStepSubtitle(step);

  return `
  <div class="sr-step sr-step--${escapeHtml(step.type)} sr-step--cat-${escapeHtml(cat)}"
       data-step-index="${i}" tabindex="0" role="button" aria-expanded="false">
    <div class="sr-step-connector">
      <div class="sr-step-line"></div>
      <div class="sr-step-dot"></div>
    </div>
    <div class="sr-step-card">
      <div class="sr-step-header">
        <div class="sr-step-icon">${getStepIcon(step)}</div>
        <div class="sr-step-meta">
          <span class="sr-step-label">${escapeHtml(getStepLabel(step))}</span>
          ${subtitle ? `<span class="sr-step-subtitle" title="${escapeHtml(subtitle)}">${escapeHtml(truncate(subtitle, 80))}</span>` : ''}
        </div>
        <div class="sr-step-right">
          ${tokens > 0 ? `<span class="sr-step-tokens">${formatTokens(tokens)}</span>` : ''}
          <svg class="sr-step-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
        </div>
      </div>
      <div class="sr-step-body" style="display:none">
        ${buildStepBody(step)}
      </div>
    </div>
  </div>`;
}

function renderGroupStep(group, i) {
  const cat = getToolCategory(group.toolName);
  const tokens = (group.estimatedInputTokens || 0) + (group.estimatedOutputTokens || 0);
  const icon = getToolIcon(group.toolName);

  // Build accordion items from individual steps
  const accordionItems = group.steps.map((step, idx) => {
    const subtitle = buildStepSubtitle(step);
    return `<div class="sr-group-accordion-item" data-group-step="${idx}">
      <div class="sr-step-icon sr-step--cat-${escapeHtml(cat)}">${icon}</div>
      <span class="sr-group-accordion-item-subtitle" title="${escapeHtml(subtitle || '')}">
        ${escapeHtml(truncate(subtitle || `${group.toolName} #${idx + 1}`, 90))}
      </span>
    </div>`;
  }).join('');

  return `
  <div class="sr-step sr-step--tool sr-step--cat-${escapeHtml(cat)} sr-step--grouped"
       data-step-index="${i}" tabindex="0" role="button" aria-expanded="false">
    <div class="sr-step-connector">
      <div class="sr-step-line"></div>
      <div class="sr-step-dot"></div>
    </div>
    <div class="sr-step-card">
      <div class="sr-step-header">
        <div class="sr-step-icon">${icon}</div>
        <div class="sr-step-meta">
          <span class="sr-step-label">${escapeHtml(group.toolName)}</span>
          <span class="sr-step-subtitle">${t('sessionReplay.groupedCalls', { count: group.count }) || `${group.count} calls`}</span>
        </div>
        <div class="sr-step-right">
          ${tokens > 0 ? `<span class="sr-step-tokens">${formatTokens(tokens)}</span>` : ''}
          <span class="sr-step-group-badge">${group.count}</span>
          <svg class="sr-step-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
        </div>
      </div>
      <div class="sr-group-accordion" style="display:none">
        ${accordionItems}
      </div>
    </div>
  </div>`;
}

function getStepLabel(step) {
  if (step.type === 'prompt') return t('sessionReplay.stepPrompt');
  if (step.type === 'response') return t('sessionReplay.stepResponse');
  if (step.type === 'thinking') return t('sessionReplay.stepThinking');
  return step.toolName || t('sessionReplay.stepTool');
}

function buildStepSubtitle(step) {
  if (step.type === 'prompt') {
    // Fix 3: show skill name as subtitle for skill prompts
    const detected = detectSkillInPrompt(step.text);
    if (detected.hasSkill) return detected.skillName;
    return truncate(step.text, 100);
  }
  if (step.type === 'response') return truncate(step.text, 100);
  if (step.type === 'thinking') return t('sessionReplay.hiddenThinking');
  if (step.filePath) return step.filePath;
  if (step.type === 'tool' && step.toolInput) {
    if (step.toolInput.command) return truncate(step.toolInput.command, 80);
    if (step.toolInput.file_path) return truncate(step.toolInput.file_path, 80);
    if (step.toolInput.path) return truncate(step.toolInput.path, 80);
    if (step.toolInput.query) return truncate(step.toolInput.query, 80);
    if (step.toolInput.pattern) return truncate(step.toolInput.pattern, 80);
    if (step.toolInput.prompt) return truncate(step.toolInput.prompt, 80);
    if (step.toolInput.url) return truncate(step.toolInput.url, 80);
  }
  return '';
}

// ── Fix 3: Render prompt body with skill chip ─────────────────────────────────
function buildPromptBody(step) {
  const detected = detectSkillInPrompt(step.text || '');
  if (detected.hasSkill) {
    const skillSvg = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>`;
    return `<div class="sr-prompt-with-skill">
      <span class="sr-skill-chip">
        ${skillSvg}
        <span class="sr-skill-chip-name">${escapeHtml(detected.skillName)}</span>
      </span>
      ${detected.rest ? `<div class="sr-prompt-rest">${escapeHtml(detected.rest)}</div>` : ''}
    </div>`;
  }
  return `<div class="sr-body-text">${escapeHtml(step.text || '')}</div>`;
}

// ── AskUserQuestion renderer ──────────────────────────────────────────────────
/**
 * Parses the AskUserQuestion output: `User has answered your questions: "Q"="A". You can now...`
 * Returns array of { question, answer } pairs.
 */
function parseAskAnswers(output) {
  if (!output) return [];
  const pairs = [];
  const regex = /"([^"]+)"="([^"]*)"/g;
  let m;
  while ((m = regex.exec(output)) !== null) {
    pairs.push({ question: m[1], answer: m[2] });
  }
  return pairs;
}

function buildAskUserQuestionBody(step) {
  const { toolInput, toolOutput } = step;

  // Extract question list: toolInput.questions[] or single toolInput.question
  const questions = [];
  if (Array.isArray(toolInput?.questions)) {
    toolInput.questions.forEach(q => {
      if (q?.question) questions.push({ text: q.question, options: q.options || [] });
    });
  } else if (toolInput?.question) {
    questions.push({ text: toolInput.question, options: [] });
  }

  // Parse answers from output string
  const answered = parseAskAnswers(toolOutput);
  // Build a map: question text → answer
  const answerMap = new Map(answered.map(p => [p.question, p.answer]));

  const qaItems = questions.map(q => {
    const answer = answerMap.get(q.text);
    // Show options if available, highlight selected
    const optionsHtml = q.options.length > 0
      ? `<div class="sr-ask-options">${q.options.map(o => {
          const isSelected = o.label === answer;
          return `<span class="sr-ask-opt${isSelected ? ' sr-ask-opt--selected' : ''}">${escapeHtml(o.label)}</span>`;
        }).join('')}</div>`
      : '';
    const answerHtml = answer !== undefined
      ? `<div class="sr-ask-answer"><span class="sr-ask-answer-chip">${escapeHtml(answer)}</span></div>`
      : '';
    return `<div class="sr-ask-qa">
      <div class="sr-ask-question">${escapeHtml(q.text)}</div>
      ${optionsHtml || answerHtml}
    </div>`;
  }).join('');

  // If no questions were parsed, fallback to showing cleaned output
  if (questions.length === 0 && toolOutput) {
    const cleaned = toolOutput
      .replace(/^User has answered your questions:\s*/i, '')
      .replace(/\.\s*You can now continue.*$/i, '')
      .trim();
    return `<div class="sr-tool-friendly"><div class="sr-ask-qa">
      <div class="sr-ask-answer"><span class="sr-ask-answer-chip">${escapeHtml(cleaned)}</span></div>
    </div></div>`;
  }

  return `<div class="sr-tool-friendly">${qaItems || ''}</div>`;
}

// ── Fix 4: Friendly tool cards ────────────────────────────────────────────────
function buildFriendlyToolBody(step) {
  const { toolName, toolInput, toolOutput } = step;
  const parts = [];

  if (toolName === 'TodoWrite') {
    // Fix 5: special TodoWrite renderer
    return buildTodoWriteBody(step);
  }

  if (toolName === 'Bash') {
    if (toolInput?.command) {
      parts.push(buildParamRow(t('sessionReplay.paramCommand') || 'Command', toolInput.command, true));
    }
    if (toolInput?.timeout !== undefined) {
      parts.push(buildParamRow(t('sessionReplay.paramTimeout') || 'Timeout', String(toolInput.timeout)));
    }
  } else if (toolName === 'Read') {
    if (toolInput?.file_path) parts.push(buildParamRow(t('sessionReplay.paramFile') || 'File', toolInput.file_path));
    if (toolInput?.offset !== undefined) parts.push(buildParamRow(t('sessionReplay.paramOffset') || 'Offset', String(toolInput.offset)));
    if (toolInput?.limit !== undefined) parts.push(buildParamRow(t('sessionReplay.paramLimit') || 'Limit', String(toolInput.limit)));
  } else if (toolName === 'Write') {
    if (toolInput?.file_path) parts.push(buildParamRow(t('sessionReplay.paramFile') || 'File', toolInput.file_path));
    if (toolInput?.content) parts.push(buildParamRow(t('sessionReplay.paramContent') || 'Content', truncate(toolInput.content, 300), true));
  } else if (toolName === 'Edit') {
    if (toolInput?.file_path) parts.push(buildParamRow(t('sessionReplay.paramFile') || 'File', toolInput.file_path));
    if (toolInput?.old_string) parts.push(buildParamRow(t('sessionReplay.paramOldString') || 'Replace', truncate(toolInput.old_string, 200), true));
    if (toolInput?.new_string) parts.push(buildParamRow(t('sessionReplay.paramNewString') || 'With', truncate(toolInput.new_string, 200), true));
  } else if (toolName === 'NotebookEdit') {
    if (toolInput?.notebook_path) parts.push(buildParamRow(t('sessionReplay.paramFile') || 'File', toolInput.notebook_path));
    if (toolInput?.new_source) parts.push(buildParamRow(t('sessionReplay.paramContent') || 'Content', truncate(toolInput.new_source, 200), true));
  } else if (toolName === 'Glob' || toolName === 'Grep') {
    if (toolInput?.pattern) parts.push(buildParamRow(t('sessionReplay.paramPattern') || 'Pattern', toolInput.pattern));
    if (toolInput?.path) parts.push(buildParamRow(t('sessionReplay.paramPath') || 'Path', toolInput.path));
  } else if (toolName === 'WebFetch') {
    if (toolInput?.url) parts.push(buildParamRow('URL', toolInput.url));
    if (toolInput?.prompt) parts.push(buildParamRow(t('sessionReplay.paramPrompt') || 'Prompt', truncate(toolInput.prompt, 150)));
  } else if (toolName === 'WebSearch') {
    if (toolInput?.query) parts.push(buildParamRow(t('sessionReplay.paramQuery') || 'Query', toolInput.query));
  } else if (toolName === 'AskUserQuestion') {
    return buildAskUserQuestionBody(step);
  } else if (toolName === 'Task') {
    if (toolInput?.description) parts.push(buildParamRow(t('sessionReplay.paramDescription') || 'Task', truncate(toolInput.description, 200)));
    if (toolInput?.prompt) parts.push(buildParamRow(t('sessionReplay.paramPrompt') || 'Prompt', truncate(toolInput.prompt, 200)));
  } else {
    // Fallback for other friendly tools — show all input params
    if (toolInput && !toolInput._truncated) {
      Object.entries(toolInput).forEach(([k, v]) => {
        const valStr = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
        parts.push(buildParamRow(k, truncate(valStr, 200), typeof v === 'string' && v.includes('\n')));
      });
    }
  }

  // Output section
  const outputHtml = buildOutputSection(step);

  return `<div class="sr-tool-friendly">${parts.join('')}${outputHtml}</div>`;
}

function buildParamRow(label, value, isCode = false) {
  return `<div class="sr-tool-param-row">
    <div class="sr-tool-param-label">${escapeHtml(label)}</div>
    <div class="sr-tool-param-value">${escapeHtml(value || '')}</div>
  </div>`;
}

function buildOutputSection(step) {
  if (step.toolOutput !== null && step.toolOutput !== undefined) {
    return `<div class="sr-body-section sr-tool-output-row">
      <div class="sr-body-label">${t('sessionReplay.output')}</div>
      <pre class="sr-code">${escapeHtml(step.toolOutput || '(empty)')}</pre>
    </div>`;
  }
  return `<div class="sr-body-section sr-tool-output-row">
    <span class="sr-truncated">${t('sessionReplay.noOutput')}</span>
  </div>`;
}

// ── Fix 5: TodoWrite renderer ─────────────────────────────────────────────────
function buildTodoWriteBody(step) {
  const { toolInput, toolOutput } = step;
  let todos = null;

  // Try to get todos from toolInput.todos
  if (toolInput?.todos && Array.isArray(toolInput.todos)) {
    todos = toolInput.todos;
  } else if (toolInput?.todos && typeof toolInput.todos === 'string') {
    try { todos = JSON.parse(toolInput.todos); } catch (e) { /* ignore */ }
  }

  if (!todos || todos.length === 0) {
    // Fallback to generic display
    return buildGenericToolBody(step);
  }

  const checkSvg = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
  const todoItems = todos.map(todo => {
    const status = todo.status || 'pending';
    const content = todo.content || todo.text || '';
    return `<div class="sr-todo-item sr-todo-item--${escapeHtml(status)}">
      <div class="sr-todo-checkbox">${status === 'completed' ? checkSvg : ''}</div>
      <span class="sr-todo-text">${escapeHtml(content)}</span>
      <div class="sr-todo-status-dot"></div>
    </div>`;
  }).join('');

  return `<div class="sr-tool-friendly">
    <div class="sr-todo-list">${todoItems}</div>
    ${buildOutputSection(step)}
  </div>`;
}

function buildGenericToolBody(step) {
  const parts = [];
  if (step.toolInput && !step.toolInput._truncated) {
    const inputStr = JSON.stringify(step.toolInput, null, 2);
    parts.push(`<div class="sr-body-section">
      <div class="sr-body-label">${t('sessionReplay.input')}</div>
      <pre class="sr-code">${escapeHtml(inputStr)}</pre>
    </div>`);
  } else if (step.toolInput?._truncated) {
    parts.push(`<div class="sr-body-section">
      <div class="sr-body-label">${t('sessionReplay.input')}</div>
      <pre class="sr-code">${escapeHtml(step.toolInput._preview)}</pre>
      <span class="sr-truncated">${t('sessionReplay.truncated')}</span>
    </div>`);
  }
  if (step.toolOutput !== null && step.toolOutput !== undefined) {
    parts.push(`<div class="sr-body-section">
      <div class="sr-body-label">${t('sessionReplay.output')}</div>
      <pre class="sr-code">${escapeHtml(step.toolOutput || '(empty)')}</pre>
    </div>`);
  } else {
    parts.push(`<div class="sr-body-section">
      <span class="sr-truncated">${t('sessionReplay.noOutput')}</span>
    </div>`);
  }
  return parts.join('');
}

function buildStepBody(step) {
  if (step.type === 'prompt') {
    return buildPromptBody(step);
  }
  if (step.type === 'response') {
    return `<div class="sr-body-text">${escapeHtml(step.text || '')}</div>`;
  }
  if (step.type === 'thinking') {
    return `<div class="sr-body-text sr-body-text--thinking">${escapeHtml(step.text || '')}</div>`;
  }
  // Tool step
  if (FRIENDLY_TOOLS.has(step.toolName)) {
    return buildFriendlyToolBody(step);
  }
  return buildGenericToolBody(step);
}

function toggleStep(el) {
  const body = el.querySelector('.sr-step-body');
  const chevron = el.querySelector('.sr-step-chevron');
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  el.setAttribute('aria-expanded', String(!isOpen));
  chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
  const idx = +el.dataset.stepIndex;
  selectedStepIndex = isOpen ? -1 : idx;
  // Deselect others
  timeline.querySelectorAll('.sr-step:not(.sr-step--grouped)').forEach(other => {
    if (other !== el) {
      const otherBody = other.querySelector('.sr-step-body');
      const otherChevron = other.querySelector('.sr-step-chevron');
      if (otherBody) otherBody.style.display = 'none';
      if (otherChevron) otherChevron.style.transform = '';
      other.setAttribute('aria-expanded', 'false');
    }
  });
}

function toggleGroupStep(el) {
  const accordion = el.querySelector('.sr-group-accordion');
  const chevron = el.querySelector('.sr-step-chevron');
  if (!accordion) return;
  const isOpen = accordion.style.display !== 'none';
  accordion.style.display = isOpen ? 'none' : 'block';
  el.setAttribute('aria-expanded', String(!isOpen));
  if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
}

function focusStep(idx) {
  const els = timeline.querySelectorAll('.sr-step');
  if (idx >= 0 && idx < els.length) {
    els[idx].focus();
  }
}

// ── Session loading ───────────────────────────────────────────────────────────

async function loadSessions(projectPath) {
  sessionSelect.setOptions(`<option value="">${t('sessionReplay.loadingSessions')}</option>`);
  sessionSelect.disabled = true;
  loadBtn.disabled = true;
  currentBranchFilter = '';
  try {
    const sessions = await window.electron_api.claude.sessions(projectPath);
    allSessions = sessions || [];
    if (allSessions.length === 0) {
      sessionSelect.setOptions(`<option value="">${t('sessionReplay.noSessions')}</option>`);
      _updateBranchFilter([]);
      return;
    }
    // Populate branch filter
    const branches = [...new Set(allSessions.map(s => s.gitBranch).filter(Boolean))].sort();
    _updateBranchFilter(branches);
    // Populate sessions
    _renderSessionOptions(allSessions);
    sessionSelect.disabled = false;
  } catch (e) {
    sessionSelect.setOptions(`<option value="">${t('sessionReplay.errorLoadingSessions')}</option>`);
    _updateBranchFilter([]);
  }
}

function _updateBranchFilter(branches) {
  if (!branchSelect) return;
  const branchGroup = container.querySelector('#sr-branch-select-wrap');
  if (branches.length === 0) {
    if (branchGroup) branchGroup.style.display = 'none';
    return;
  }
  if (branchGroup) branchGroup.style.display = '';
  branchSelect.setOptions(
    `<option value="">${t('sessions.allBranches')}</option>` +
    branches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')
  );
  branchSelect.disabled = false;
}

function _renderSessionOptions(sessions) {
  sessionSelect.setOptions(
    `<option value="">${t('sessionReplay.selectSession')}</option>` +
    sessions.map(s => {
      const label = s.summary || truncate(s.firstPrompt, 70) || s.sessionId;
      const date = s.modified ? new Date(s.modified).toLocaleDateString() : '';
      const branch = s.gitBranch ? ` [${s.gitBranch}]` : '';
      return `<option value="${escapeHtml(s.sessionId)}">${escapeHtml(label)} — ${escapeHtml(date)}${escapeHtml(branch)}</option>`;
    }).join('')
  );
}

function _applyBranchFilter() {
  const filtered = currentBranchFilter
    ? allSessions.filter(s => s.gitBranch === currentBranchFilter)
    : allSessions;
  if (filtered.length === 0) {
    sessionSelect.setOptions(`<option value="">${t('sessionReplay.noSessions')}</option>`);
    sessionSelect.disabled = true;
    loadBtn.disabled = true;
  } else {
    _renderSessionOptions(filtered);
    sessionSelect.disabled = false;
  }
}

async function _deleteCurrentSession(sessionId) {
  const projectPath = projectSelect.value;
  if (!projectPath || !sessionId) return;
  try {
    const result = await window.electron_api.claude.deleteSession({ projectPath, sessionId });
    if (result.success) {
      // Reload sessions
      await loadSessions(projectPath);
      // Reset replay if the deleted session was loaded
      if (currentSessionId === sessionId) {
        currentSessionId = null;
        currentSteps = [];
        currentSummary = {};
        summaryBar.innerHTML = '';
        timeline.innerHTML = buildEmptyStateHtml();
        if (viewToggleEl) viewToggleEl.hidden = true;
      }
      return true;
    } else {
      return false;
    }
  } catch {
    return false;
  }
}

async function loadReplay() {
  const projectPath = projectSelect.value;
  const sessionId = sessionSelect.value;
  if (!projectPath || !sessionId) return;

  loadBtn.disabled = true;
  _setLoadBtnLabel(t('sessionReplay.loading'));
  timeline.innerHTML = `<div class="sr-loading"><div class="sr-spinner"></div>${t('sessionReplay.parsing')}</div>`;
  summaryBar.innerHTML = '';

  try {
    const result = await window.electron_api.claude.sessionReplay({ projectPath, sessionId });
    if (!result.success) throw new Error(result.error || 'Unknown error');
    currentSteps = result.steps || [];
    currentSummary = result.summary || {};
    currentProjectPath = projectPath;
    currentSessionId = sessionId;
    selectedStepIndex = -1;
    renderSummary(currentSummary);
    currentView = 'timeline';
    renderTimeline(currentSteps);
    _renderViewToggle();
    // Show export button
    const exportBtn = container.querySelector('#sr-export-btn');
    if (exportBtn) exportBtn.hidden = false;
  } catch (e) {
    timeline.innerHTML = `<div class="sr-empty sr-empty--error">${t('sessionReplay.errorLoading')}: ${escapeHtml(e.message)}</div>`;
  } finally {
    loadBtn.disabled = false;
    _setLoadBtnLabel(t('sessionReplay.load'));
  }
}

// ── Custom Select Widget ──────────────────────────────────────────────────────
/**
 * Lightweight custom select replacing native <select>.
 * API: { el, value, disabled, setOptions(html), addEventListener(change, cb), destroy() }
 */
function makeCustomSelect(placeholder) {
  let _value = '';
  let _options = [];
  let _isOpen = false;
  let _isDisabled = false;
  const _changeListeners = [];

  const wrapper = document.createElement('div');
  wrapper.className = 'sr-cs';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'sr-cs-trigger';
  trigger.innerHTML = `
    <span class="sr-cs-label sr-cs-label--placeholder">${escapeHtml(placeholder)}</span>
    <svg class="sr-cs-chevron" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M7 10l5 5 5-5z"/></svg>
  `;
  const _labelEl = trigger.querySelector('.sr-cs-label');

  const menu = document.createElement('div');
  menu.className = 'sr-cs-menu';
  menu.hidden = true;

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);

  function _updateDisplay() {
    const selected = _options.find(o => o.value === _value);
    if (selected && _value !== '') {
      _labelEl.textContent = selected.label;
      _labelEl.classList.remove('sr-cs-label--placeholder');
    } else {
      const statusOpt = _options.find(o => o.value === '');
      _labelEl.textContent = statusOpt ? statusOpt.label : placeholder;
      _labelEl.classList.add('sr-cs-label--placeholder');
    }
  }

  function _buildMenu() {
    menu.innerHTML = '';
    const selectableOpts = _options.filter(o => o.value !== '');
    if (selectableOpts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sr-cs-empty';
      const statusOpt = _options.find(o => o.value === '');
      empty.textContent = statusOpt ? statusOpt.label : placeholder;
      menu.appendChild(empty);
      return;
    }
    selectableOpts.forEach(opt => {
      const item = document.createElement('div');
      item.className = 'sr-cs-option' + (opt.value === _value ? ' sr-cs-option--selected' : '');
      item.textContent = opt.label;
      item.tabIndex = -1;
      item.addEventListener('click', () => {
        _value = opt.value;
        _updateDisplay();
        _buildMenu();
        _closeMenu();
        _changeListeners.forEach(cb => cb());
      });
      item.addEventListener('keydown', e => {
        const items = [...menu.querySelectorAll('.sr-cs-option')];
        const idx = items.indexOf(item);
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); items[idx + 1]?.focus(); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); (idx === 0 ? trigger : items[idx - 1])?.focus(); }
        if (e.key === 'Escape')    { e.preventDefault(); _closeMenu(); trigger.focus(); }
      });
      menu.appendChild(item);
    });
  }

  function _openMenu() {
    if (_isDisabled) return;
    _isOpen = true;
    menu.hidden = false;
    wrapper.classList.add('sr-cs--open');
    requestAnimationFrame(() => {
      (menu.querySelector('.sr-cs-option--selected') || menu.querySelector('.sr-cs-option'))?.focus();
    });
  }

  function _closeMenu() {
    _isOpen = false;
    menu.hidden = true;
    wrapper.classList.remove('sr-cs--open');
  }

  trigger.addEventListener('click', () => _isOpen ? _closeMenu() : _openMenu());
  trigger.addEventListener('keydown', e => {
    if (['ArrowDown', 'Enter', ' '].includes(e.key)) { e.preventDefault(); _openMenu(); }
  });

  const _outsideHandler = e => { if (_isOpen && !wrapper.contains(e.target)) _closeMenu(); };
  document.addEventListener('click', _outsideHandler, true);

  return {
    el: wrapper,
    get value() { return _value; },
    set value(val) {
      const opt = _options.find(o => o.value === val);
      _value = opt ? val : '';
      _updateDisplay();
    },
    get disabled() { return _isDisabled; },
    set disabled(val) {
      _isDisabled = !!val;
      trigger.disabled = _isDisabled;
      wrapper.classList.toggle('sr-cs--disabled', _isDisabled);
    },
    setOptions(html) {
      const tmp = document.createElement('select');
      tmp.innerHTML = html;
      _options = [...tmp.options].map(o => ({ value: o.value, label: o.text }));
      _value = '';
      _updateDisplay();
      _buildMenu();
    },
    addEventListener(event, cb) {
      if (event === 'change') _changeListeners.push(cb);
    },
    destroy() {
      document.removeEventListener('click', _outsideHandler, true);
    },
  };
}

// ── Player ────────────────────────────────────────────────────────────────────

function buildPlayerBarHtml(total) {
  const playSvg  = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M8 5v14l11-7z"/></svg>`;
  const prevSvg  = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>`;
  const nextSvg  = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>`;
  const rstSvg   = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>`;
  const listSvg  = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>`;
  return `
    <div class="sr-pbar-scrubber">
      <div class="sr-pbar-track" id="sr-pbar-track">
        <div class="sr-pbar-fill" id="sr-pbar-fill" style="width:0%"></div>
        <div class="sr-pbar-thumb" id="sr-pbar-thumb" style="left:0%"></div>
      </div>
      <span class="sr-pbar-counter" id="sr-pbar-counter">0 / ${total}</span>
    </div>
    <div class="sr-pbar-controls">
      <button class="sr-pbar-btn" id="sr-pbar-restart" title="Recommencer">${rstSvg}</button>
      <button class="sr-pbar-btn" id="sr-pbar-prev" title="Précédent" disabled>${prevSvg}</button>
      <button class="sr-pbar-btn sr-pbar-btn--play" id="sr-pbar-play" title="Lire">${playSvg}</button>
      <button class="sr-pbar-btn" id="sr-pbar-next" title="Suivant">${nextSvg}</button>
      <div class="sr-pbar-speeds">
        <button class="sr-pbar-speed" data-speed="0.5">0.5×</button>
        <button class="sr-pbar-speed sr-pbar-speed--active" data-speed="1">1×</button>
        <button class="sr-pbar-speed" data-speed="2">2×</button>
        <button class="sr-pbar-speed" data-speed="4">4×</button>
      </div>
      <button class="sr-pbar-btn sr-pbar-btn--sm" id="sr-pbar-timeline" title="Vue timeline">${listSvg}</button>
    </div>
  `;
}

function buildPlayerStepEl(step) {
  const el = document.createElement('div');
  el.className = 'sr-pstep';

  if (step.type === 'prompt') {
    const detected = detectSkillInPrompt(step.text || '');
    let inner;
    if (detected.hasSkill) {
      const svg = `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>`;
      inner = `<span class="sr-pstep-skill-chip">${svg}${escapeHtml(detected.skillName)}</span>`;
    } else {
      inner = escapeHtml(truncate(step.text || '', 200));
    }
    el.classList.add('sr-pstep--prompt');
    el.innerHTML = `<div class="sr-pstep-user-pill">${inner}</div>`;

  } else if (step.type === 'thinking') {
    el.classList.add('sr-pstep--thinking');
    el.innerHTML = `<div class="sr-pstep-thinking-dots"><span></span><span></span><span></span></div>`;

  } else if (step.type === 'response') {
    el.classList.add('sr-pstep--response');
    el.innerHTML = `<div class="sr-pstep-response-text">${escapeHtml(truncate(step.text || '', 300))}</div>`;

  } else if (step.type === 'tool' || step.type === 'group') {
    const cat = getToolCategory(step.toolName);
    const rgb = CAT_COLORS[cat] || CAT_COLORS.other;
    el.classList.add('sr-pstep--tool');
    const sub = step.type === 'group' ? `${step.count} appels` : buildStepSubtitle(step);
    const badge = step.type === 'group'
      ? `<span class="sr-pstep-tc-badge">${step.count}</span>`
      : `<svg class="sr-pstep-tc-check" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
    const iconSvg = getToolIcon(step.toolName).replace('<svg ', '<svg class="sr-pstep-tc-icon" ');
    el.innerHTML = `
      <div class="sr-pstep-tc" style="--tc:${rgb}">
        ${iconSvg}
        <div class="sr-pstep-tc-info">
          <span class="sr-pstep-tc-name">${escapeHtml(step.toolName || '')}</span>
          ${sub ? `<span class="sr-pstep-tc-detail" title="${escapeHtml(sub)}">${escapeHtml(truncate(sub, 60))}</span>` : ''}
        </div>
        ${badge}
      </div>`;
  }
  return el;
}

function _appendStep(idx) {
  if (idx < 0 || idx >= playerSteps.length) return;
  playerChatEl.appendChild(buildPlayerStepEl(playerSteps[idx]));
  playerCurrentStep = idx;
}

function _updatePlayerBar() {
  if (!playerBarEl) return;
  const total = playerSteps.length;
  const current = playerCurrentStep + 1;
  const pct = total > 0 ? (current / total) * 100 : 0;
  const fill    = playerBarEl.querySelector('#sr-pbar-fill');
  const thumb   = playerBarEl.querySelector('#sr-pbar-thumb');
  const counter = playerBarEl.querySelector('#sr-pbar-counter');
  if (fill)    fill.style.width = `${pct}%`;
  if (thumb)   thumb.style.left = `${pct}%`;
  if (counter) counter.textContent = `${current} / ${total}`;
  const prevBtn = playerBarEl.querySelector('#sr-pbar-prev');
  const nextBtn = playerBarEl.querySelector('#sr-pbar-next');
  if (prevBtn) prevBtn.disabled = playerCurrentStep <= 0;
  if (nextBtn) nextBtn.disabled = playerCurrentStep >= total - 1;
}

function _updatePlayBtn() {
  const btn = playerBarEl?.querySelector('#sr-pbar-play');
  if (!btn) return;
  const playSvg  = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M8 5v14l11-7z"/></svg>`;
  const pauseSvg = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
  btn.innerHTML = playerIsPlaying ? pauseSvg : playSvg;
}

function _startTimer() {
  const delay = PLAYER_SPEED_DELAYS[playerSpeed] || 1000;
  playerTimer = setInterval(() => {
    if (playerCurrentStep >= playerSteps.length - 1) {
      _playerPause();
      return;
    }
    _appendStep(playerCurrentStep + 1);
    _updatePlayerBar();
    requestAnimationFrame(() => { playerChatEl.scrollTop = playerChatEl.scrollHeight; });
  }, delay);
}

function _setLoadBtnLabel(text) {
  if (!loadBtn) return;
  const svg = loadBtn.querySelector('svg');
  if (svg) {
    // Keep SVG, update text after it
    const span = loadBtn.querySelector('.sr-load-label') || document.createElement('span');
    span.className = 'sr-load-label';
    span.textContent = text;
    if (!loadBtn.querySelector('.sr-load-label')) loadBtn.appendChild(span);
  } else {
    loadBtn.textContent = text;
  }
}

function _playerPause() {
  if (!playerIsPlaying) return;
  playerIsPlaying = false;
  if (playerTimer) { clearInterval(playerTimer); playerTimer = null; }
  _updatePlayBtn();
}

function _playerPlay() {
  if (playerIsPlaying) return;
  if (playerCurrentStep >= playerSteps.length - 1) {
    // Finished — restart from beginning
    playerChatEl.innerHTML = '';
    playerCurrentStep = -1;
    _updatePlayerBar();
  }
  playerIsPlaying = true;
  _updatePlayBtn();
  _startTimer();
}

function playerSeekTo(idx) {
  idx = Math.max(0, Math.min(playerSteps.length - 1, idx));
  _playerPause();
  if (idx < playerCurrentStep) {
    playerChatEl.innerHTML = '';
    playerCurrentStep = -1;
  }
  for (let i = playerCurrentStep + 1; i <= idx; i++) _appendStep(i);
  _updatePlayerBar();
  requestAnimationFrame(() => { playerChatEl.scrollTop = playerChatEl.scrollHeight; });
}

// ── View toggle helpers ───────────────────────────────────────────────────────
function _renderViewToggle() {
  if (!viewToggleEl) return;
  const playSvg = `<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M8 5v14l11-7z"/></svg>`;
  const listSvg = `<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>`;
  if (currentView === 'timeline') {
    viewToggleEl.innerHTML = `<button class="sr-view-btn sr-view-btn--player">${playSvg} Lecture</button>`;
  } else {
    viewToggleEl.innerHTML = `<button class="sr-view-btn sr-view-btn--timeline">${listSvg} Timeline</button>`;
  }
  viewToggleEl.querySelector('.sr-view-btn').addEventListener('click', () => {
    if (currentView === 'timeline') _switchToPlayer();
    else _switchToTimeline();
  });
  viewToggleEl.hidden = false;
}

function _switchToTimeline() {
  _playerPause();
  currentView = 'timeline';
  playerChatEl.hidden = true;
  playerBarEl.hidden = true;
  timeline.hidden = false;
  renderTimeline(currentSteps);
  _renderViewToggle();
}

function _switchToPlayer() {
  currentView = 'player';
  initPlayer(currentSteps);
  _renderViewToggle();
}

function initPlayer(rawSteps) {
  // Filter system-injected noise: skill base-directory reminders
  const filtered = rawSteps.filter(step => {
    if (step.type !== 'prompt') return true;
    const txt = step.text || '';
    if (txt.startsWith('Base directory for this skill:')) return false;
    if (txt.includes('"Base directory for this skill:')) return false;
    return true;
  });
  playerSteps = groupConsecutiveAgents(filtered);
  playerCurrentStep = -1;
  playerIsPlaying = false;
  playerSpeed = 1;
  if (playerTimer) { clearInterval(playerTimer); playerTimer = null; }
  if (_playerDragCleanup) { _playerDragCleanup(); _playerDragCleanup = null; }

  // Build bar HTML
  playerBarEl.innerHTML = buildPlayerBarHtml(playerSteps.length);

  // Switch to player view
  timeline.hidden = true;
  playerChatEl.innerHTML = '';
  playerChatEl.hidden = false;
  playerBarEl.hidden = false;
  _updatePlayerBar();

  // Controls
  playerBarEl.querySelector('#sr-pbar-play').addEventListener('click', () =>
    playerIsPlaying ? _playerPause() : _playerPlay());

  playerBarEl.querySelector('#sr-pbar-prev').addEventListener('click', () => {
    _playerPause();
    if (playerCurrentStep > 0) playerSeekTo(playerCurrentStep - 1);
  });

  playerBarEl.querySelector('#sr-pbar-next').addEventListener('click', () => {
    _playerPause();
    if (playerCurrentStep < playerSteps.length - 1) playerSeekTo(playerCurrentStep + 1);
  });

  playerBarEl.querySelector('#sr-pbar-restart').addEventListener('click', () => {
    _playerPause();
    playerChatEl.innerHTML = '';
    playerCurrentStep = -1;
    _updatePlayerBar();
  });

  playerBarEl.querySelector('#sr-pbar-timeline').addEventListener('click', () => _switchToTimeline());

  playerBarEl.querySelectorAll('.sr-pbar-speed').forEach(btn => {
    btn.addEventListener('click', () => {
      playerSpeed = parseFloat(btn.dataset.speed);
      playerBarEl.querySelectorAll('.sr-pbar-speed').forEach(b => b.classList.remove('sr-pbar-speed--active'));
      btn.classList.add('sr-pbar-speed--active');
      if (playerIsPlaying) {
        clearInterval(playerTimer);
        playerTimer = null;
        _startTimer();
      }
    });
  });

  // Scrubber drag
  const trackEl = playerBarEl.querySelector('#sr-pbar-track');
  let isDragging = false;
  function seekFromEvent(e) {
    const rect = trackEl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    playerSeekTo(Math.round(ratio * (playerSteps.length - 1)));
  }
  function onMove(e) { if (isDragging) seekFromEvent(e); }
  function onUp()    { isDragging = false; }
  trackEl.addEventListener('mousedown', e => { isDragging = true; seekFromEvent(e); });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  _playerDragCleanup = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  // Auto-play
  _playerPlay();
}

// ── Initialization ────────────────────────────────────────────────────────────

function buildEmptyStateHtml() {
  return `
    <div class="sr-empty-state">
      <div class="sr-empty-illustration" aria-hidden="true">
        <div class="sr-ei-track">
          <div class="sr-ei-row">
            <div class="sr-ei-connector">
              <div class="sr-ei-dot sr-ei-dot--prompt"></div>
              <div class="sr-ei-line"></div>
            </div>
            <div class="sr-ei-card">
              <div class="sr-ei-card-icon sr-ei-icon--prompt"></div>
              <div class="sr-ei-card-bars">
                <div class="sr-ei-bar sr-ei-bar--60"></div>
                <div class="sr-ei-bar sr-ei-bar--40"></div>
              </div>
            </div>
          </div>
          <div class="sr-ei-row">
            <div class="sr-ei-connector">
              <div class="sr-ei-dot sr-ei-dot--file"></div>
              <div class="sr-ei-line"></div>
            </div>
            <div class="sr-ei-card">
              <div class="sr-ei-card-icon sr-ei-icon--file"></div>
              <div class="sr-ei-card-bars">
                <div class="sr-ei-bar sr-ei-bar--45"></div>
                <div class="sr-ei-bar sr-ei-bar--70"></div>
              </div>
            </div>
          </div>
          <div class="sr-ei-row">
            <div class="sr-ei-connector">
              <div class="sr-ei-dot sr-ei-dot--terminal"></div>
              <div class="sr-ei-line"></div>
            </div>
            <div class="sr-ei-card">
              <div class="sr-ei-card-icon sr-ei-icon--terminal"></div>
              <div class="sr-ei-card-bars">
                <div class="sr-ei-bar sr-ei-bar--75"></div>
                <div class="sr-ei-bar sr-ei-bar--50"></div>
              </div>
            </div>
          </div>
          <div class="sr-ei-row">
            <div class="sr-ei-connector">
              <div class="sr-ei-dot sr-ei-dot--response"></div>
            </div>
            <div class="sr-ei-card">
              <div class="sr-ei-card-icon sr-ei-icon--response"></div>
              <div class="sr-ei-card-bars">
                <div class="sr-ei-bar sr-ei-bar--55"></div>
                <div class="sr-ei-bar sr-ei-bar--35"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="sr-empty-content">
        <div class="sr-empty-title">${t('sessionReplay.title')}</div>
        <div class="sr-empty-desc">${t('sessionReplay.emptyDesc')}</div>
        <div class="sr-empty-steps">
          <div class="sr-empty-step">
            <div class="sr-empty-step-num">1</div>
            <div class="sr-empty-step-label">${t('sessionReplay.emptyStepProject')}</div>
          </div>
          <div class="sr-empty-step-sep">›</div>
          <div class="sr-empty-step">
            <div class="sr-empty-step-num">2</div>
            <div class="sr-empty-step-label">${t('sessionReplay.emptyStepSession')}</div>
          </div>
          <div class="sr-empty-step-sep">›</div>
          <div class="sr-empty-step">
            <div class="sr-empty-step-num">3</div>
            <div class="sr-empty-step-label">${t('sessionReplay.load')}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildHtml() {
  return `
    <div class="sr-panel">
      <div class="sr-header">
        <div class="sr-header-top">
          <div class="sr-title">
            <div class="sr-title-icon">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
            </div>
            <span>${t('sessionReplay.title')}</span>
          </div>
          <div class="sr-header-actions">
            <button class="sr-action-btn sr-export-btn" id="sr-export-btn" title="${t('sessions.export')}" hidden>
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              <span>${t('sessions.export')}</span>
            </button>
            <div id="sr-view-toggle" class="sr-view-toggle" hidden></div>
          </div>
        </div>
        <div class="sr-controls">
          <div class="sr-control-group sr-control-group--project">
            <label class="sr-control-label">${t('sessionReplay.labelProject')}</label>
            <div class="sr-cs-container" id="sr-project-select-wrap"></div>
          </div>
          <div class="sr-control-group sr-control-group--branch" id="sr-branch-select-wrap" style="display:none">
            <label class="sr-control-label">${t('sessions.filterBranch')}</label>
            <div class="sr-cs-container"></div>
          </div>
          <div class="sr-control-group sr-control-group--session">
            <label class="sr-control-label">${t('sessionReplay.labelSession')}</label>
            <div class="sr-cs-container sr-session-select-row" id="sr-session-select-wrap"></div>
          </div>
          <div class="sr-control-actions">
            <button class="sr-action-btn sr-delete-btn" id="sr-delete-btn" title="${t('sessions.delete')}" disabled>
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
            <button class="sr-load-btn" id="sr-load-btn" disabled>
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
              <span class="sr-load-label">${t('sessionReplay.load')}</span>
            </button>
          </div>
        </div>
      </div>
      <div class="sr-meta">
        <div class="sr-summary" id="sr-summary"></div>
      </div>
      <div class="sr-timeline" id="sr-timeline">
        ${buildEmptyStateHtml()}
      </div>
      <div class="sr-player-chat" id="sr-player-chat" hidden></div>
      <div class="sr-player-bar" id="sr-player-bar" hidden></div>
    </div>
  `;
}

function init(containerEl, opts = {}) {
  container = containerEl;
  projectsState = opts.projectsState || null;
  container.innerHTML = buildHtml();

  // Bind basic DOM refs
  loadBtn = container.querySelector('#sr-load-btn');
  summaryBar = container.querySelector('#sr-summary');
  viewToggleEl = container.querySelector('#sr-view-toggle');
  timeline = container.querySelector('#sr-timeline');
  playerChatEl = container.querySelector('#sr-player-chat');
  playerBarEl = container.querySelector('#sr-player-bar');

  const deleteBtn = container.querySelector('#sr-delete-btn');
  const exportBtn = container.querySelector('#sr-export-btn');

  // Create and inject custom select widgets
  const projWidget = makeCustomSelect(t('sessionReplay.selectProject'));
  const branchWidget = makeCustomSelect(t('sessions.allBranches'));
  const sessWidget = makeCustomSelect(t('sessionReplay.selectSession'));
  branchWidget.disabled = true;
  sessWidget.disabled = true;
  container.querySelector('#sr-project-select-wrap').appendChild(projWidget.el);
  container.querySelector('#sr-branch-select-wrap .sr-cs-container').appendChild(branchWidget.el);
  container.querySelector('#sr-session-select-wrap').appendChild(sessWidget.el);
  projectSelect = projWidget;
  branchSelect = branchWidget;
  sessionSelect = sessWidget;

  // Populate project list
  if (projectsState) {
    const state = projectsState.get();
    const projects = state.projects || [];
    projectSelect.setOptions(
      `<option value="">${t('sessionReplay.selectProject')}</option>` +
      projects.map(p => `<option value="${escapeHtml(p.path)}">${escapeHtml(p.name || p.path)}</option>`).join('')
    );

    // Default to open project
    const openedId = opts.openedProjectId || state.openedProjectId;
    if (openedId) {
      const openedProject = projects.find(p => p.id === openedId);
      if (openedProject) {
        projectSelect.value = openedProject.path;
        loadSessions(openedProject.path);
      }
    }
  }

  // Event listeners
  projectSelect.addEventListener('change', () => {
    const path = projectSelect.value;
    sessionSelect.setOptions(`<option value="">${t('sessionReplay.selectSession')}</option>`);
    sessionSelect.disabled = true;
    loadBtn.disabled = true;
    deleteBtn.disabled = true;
    allSessions = [];
    // Reset player
    _playerPause();
    if (playerChatEl) { playerChatEl.hidden = true; playerChatEl.innerHTML = ''; }
    if (playerBarEl)  playerBarEl.hidden = true;
    playerSteps = [];
    playerCurrentStep = -1;
    currentView = 'timeline';
    if (viewToggleEl) viewToggleEl.hidden = true;
    if (exportBtn) exportBtn.hidden = true;
    timeline.hidden = false;
    timeline.innerHTML = buildEmptyStateHtml();
    summaryBar.innerHTML = '';
    currentSteps = [];
    if (path) loadSessions(path);
  });

  // Branch filter
  branchSelect.addEventListener('change', () => {
    currentBranchFilter = branchSelect.value;
    _applyBranchFilter();
  });

  sessionSelect.addEventListener('change', () => {
    const hasValue = !!sessionSelect.value;
    loadBtn.disabled = !hasValue;
    deleteBtn.disabled = !hasValue;
  });

  // Delete session
  deleteBtn.addEventListener('click', async () => {
    const sessionId = sessionSelect.value;
    if (!sessionId) return;
    // Inline confirmation
    const { showConfirm } = require('../components/Modal');
    const confirmed = await showConfirm({
      title: t('sessions.delete'),
      message: t('sessions.confirmDelete'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      danger: true
    });
    if (!confirmed) return;
    const ok = await _deleteCurrentSession(sessionId);
    const { showToast } = require('../components/Toast');
    if (ok) {
      showToast({ type: 'success', message: t('sessions.deleted'), duration: 3000 });
    } else {
      showToast({ type: 'error', message: t('sessions.deleteError'), duration: 4000 });
    }
  });

  // Export session
  exportBtn.addEventListener('click', async () => {
    if (!currentProjectPath || !currentSessionId) return;
    const { createModal, showModal, closeModal } = require('../components/Modal');
    const modal = createModal({
      id: 'export-session-modal',
      title: t('sessions.exportFormat'),
      size: 'small',
      content: `
        <div style="display:flex;gap:12px;justify-content:center;padding:16px 0">
          <button class="sr-export-format-btn" data-format="markdown" style="padding:10px 24px;border-radius:var(--radius);border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;font-size:var(--font-base)">
            ${t('sessions.exportMarkdown')}
          </button>
          <button class="sr-export-format-btn" data-format="json" style="padding:10px 24px;border-radius:var(--radius);border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;font-size:var(--font-base)">
            ${t('sessions.exportJson')}
          </button>
        </div>
      `,
      buttons: [{ label: t('common.cancel'), action: 'cancel' }]
    });
    showModal(modal);
    modal.querySelectorAll('.sr-export-format-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const format = btn.dataset.format;
        closeModal(modal);
        try {
          const result = await window.electron_api.claude.exportSession({
            projectPath: currentProjectPath,
            sessionId: currentSessionId,
            format
          });
          if (!result.success) throw new Error(result.error);
          // Save to file via dialog
          const ext = format === 'json' ? 'json' : 'md';
          const filePath = await window.electron_api.dialog.saveFileDialog({
            defaultPath: `session-${currentSessionId.slice(0, 8)}.${ext}`,
            filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [ext] }]
          });
          if (filePath) {
            const { fs } = window.electron_nodeModules;
            await fs.promises.writeFile(filePath, result.content, 'utf8');
            const { showToast } = require('../components/Toast');
            showToast({ type: 'success', message: t('sessions.exportedTo', { path: filePath }), duration: 4000 });
          }
        } catch (e) {
          const { showToast } = require('../components/Toast');
          showToast({ type: 'error', message: t('sessions.exportError') + ': ' + e.message, duration: 4000 });
        }
      });
    });
  });

  loadBtn.addEventListener('click', loadReplay);
}

function cleanup() {
  currentSteps = [];
  currentSummary = {};
  selectedStepIndex = -1;
  allSessions = [];
  currentBranchFilter = '';
  _playerPause();
  if (_playerDragCleanup) { _playerDragCleanup(); _playerDragCleanup = null; }
  playerSteps = [];
  playerCurrentStep = -1;
  if (projectSelect?.destroy) projectSelect.destroy();
  if (branchSelect?.destroy) branchSelect.destroy();
  if (sessionSelect?.destroy) sessionSelect.destroy();
}

module.exports = { init, cleanup };
