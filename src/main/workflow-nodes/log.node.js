'use strict';

const { esc } = require('./_registry');

module.exports = {
  type:     'workflow/log',
  title:    'Log',
  desc:     'Écrire dans le log',
  color:    'slate',
  width:    200,
  category: 'flow',
  icon:     'log',

  inputs:  [{ name: 'In', type: 'exec' }, { name: 'message', type: 'string' }],
  outputs: [{ name: 'Done', type: 'exec' }],

  props: { level: 'info', message: '' },

  fields: [
    {
      type: 'custom',
      key:  'log_ui',
      render(field, props, node) {
        const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const LOG_LEVELS = [
          { value: 'debug', label: 'Debug', icon: '🔍', color: 'var(--text-muted)' },
          { value: 'info',  label: 'Info',  icon: 'ℹ',  color: '#60a5fa' },
          { value: 'warn',  label: 'Warn',  icon: '⚠',  color: '#fbbf24' },
          { value: 'error', label: 'Error', icon: '✕',  color: '#f87171' },
        ];
        const LOG_TEMPLATES = [
          { label: 'Status', value: '[$ctx.project] Step $loop.index completed' },
          { label: 'Result', value: 'Output: $node_1.stdout' },
          { label: 'Timing', value: 'Done at $ctx.date' },
        ];
        const p        = props || {};
        const logLevel = p.level || 'info';
        const currentLevel = LOG_LEVELS.find(l => l.value === logLevel) || LOG_LEVELS[1];

        return `
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Niveau</label>
            <div class="wf-log-level-tabs">
              ${LOG_LEVELS.map(l => `
                <button class="wf-log-level-tab ${logLevel === l.value ? 'active' : ''}" data-level="${l.value}" style="${logLevel === l.value ? `--tab-color:${l.color}` : ''}">
                  <span class="wf-log-level-icon">${l.icon}</span>
                  ${l.label}
                </button>
              `).join('')}
            </div>
          </div>
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">Message</label>
            <div class="wf-log-tpl-bar">
              ${LOG_TEMPLATES.map(t => `<button class="wf-log-tpl" data-tpl="${esc(t.value)}" title="${esc(t.value)}">${esc(t.label)}</button>`).join('')}
            </div>
            <textarea class="wf-step-edit-input wf-node-prop wf-log-textarea" data-key="message" rows="3" placeholder="Build finished for $ctx.project">${esc(p.message || '')}</textarea>
            <div class="wf-log-preview" data-level="${logLevel}">
              <span class="wf-log-preview-badge">${currentLevel.icon}</span>
              <span class="wf-log-preview-text">${esc(p.message || 'Aperçu du message...')}</span>
            </div>
          </div>
        `;
      },
      bind(container, field, node, onChange) {
        const LOG_LEVELS = [
          { value: 'debug', icon: '🔍', color: 'var(--text-muted)' },
          { value: 'info',  icon: 'ℹ',  color: '#60a5fa' },
          { value: 'warn',  icon: '⚠',  color: '#fbbf24' },
          { value: 'error', icon: '✕',  color: '#f87171' },
        ];

        // Level tabs
        container.querySelectorAll('.wf-log-level-tab').forEach(btn => {
          btn.addEventListener('click', () => {
            const level = btn.dataset.level;
            node.properties.level = level;
            const levelInfo = LOG_LEVELS.find(l => l.value === level) || LOG_LEVELS[1];

            container.querySelectorAll('.wf-log-level-tab').forEach(b => {
              const isActive = b.dataset.level === level;
              b.classList.toggle('active', isActive);
              if (isActive) {
                const lInfo = LOG_LEVELS.find(l => l.value === b.dataset.level);
                b.style.setProperty('--tab-color', lInfo?.color || '');
              } else {
                b.style.removeProperty('--tab-color');
              }
            });

            const preview = container.querySelector('.wf-log-preview');
            if (preview) {
              preview.dataset.level = level;
              const badge = preview.querySelector('.wf-log-preview-badge');
              if (badge) badge.textContent = levelInfo.icon;
            }
            onChange(level);
          });
        });

        // Template buttons
        container.querySelectorAll('.wf-log-tpl').forEach(btn => {
          btn.addEventListener('click', () => {
            const textarea = container.querySelector('.wf-log-textarea');
            if (textarea) {
              textarea.value = btn.dataset.tpl;
              node.properties.message = textarea.value;
              const preview = container.querySelector('.wf-log-preview-text');
              if (preview) preview.textContent = textarea.value || 'Aperçu du message...';
              onChange(textarea.value);
            }
          });
        });

        // Live preview from textarea
        const textarea = container.querySelector('.wf-log-textarea');
        textarea?.addEventListener('input', () => {
          const preview = container.querySelector('.wf-log-preview-text');
          if (preview) preview.textContent = textarea.value || 'Aperçu du message...';
        });
      },
    },
  ],

  badge: (n) => (n.properties.level || 'info').toUpperCase(),
  badgeColor: (n) => ({ debug: '#94a3b8', info: '#60a5fa', warn: '#fbbf24', error: '#ef4444' }[n.properties.level]),

  run(config, vars, signal, ctx) {
    const resolveVars = (value, vars) => {
      if (typeof value !== 'string') return value;
      return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
        const parts = key.split('.');
        let cur = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
        return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
      });
    };

    const level   = config.level   || 'info';
    const message = resolveVars(config.message || '', vars);

    if (ctx?.sendFn) ctx.sendFn('workflow-log', { level, message, timestamp: Date.now() });

    return { level, message, logged: true };
  },
};
