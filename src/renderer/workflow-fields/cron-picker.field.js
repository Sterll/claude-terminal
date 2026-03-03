const { escapeHtml, escapeAttr } = require('./_registry');
const { t } = require('../i18n');

const PRESET_VALUES = ['* * * * *', '0 * * * *', '0 0 * * *', '0 0 * * 1'];
const PRESET_KEYS  = ['everyMinute', 'everyHour', 'everyDayMidnight', 'everyMonday'];

function getPresets() {
  return PRESET_VALUES.map((value, i) => ({ value, label: t(`workflow.cron.${PRESET_KEYS[i]}`) }));
}

module.exports = {
  type: 'cron-picker',

  render(field, value, node) {
    const presetHtml = getPresets().map(p =>
      `<button type="button" class="wf-cron-preset" data-value="${escapeAttr(p.value)}">${escapeHtml(p.label)}</button>`
    ).join('');

    return `<div class="wf-field-group" data-key="${escapeAttr(field.key)}">
  <label class="wf-field-label">${escapeHtml(field.label || 'Planning')}</label>
  <input type="text" class="wf-input wf-cron-input" value="${escapeAttr(value || '')}"
         placeholder="* * * * *" data-key="${escapeAttr(field.key)}" />
  <div class="wf-cron-presets">${presetHtml}</div>
  <span class="wf-cron-desc"></span>
</div>`;
  },

  bind(container, field, node, onChange) {
    const input = container.querySelector('.wf-cron-input');
    const desc  = container.querySelector('.wf-cron-desc');

    function updateDesc(val) {
      if (!desc) return;
      if (!val) {
        desc.textContent = '';
        return;
      }
      // Match against known presets for a human-readable label
      const preset = getPresets().find(p => p.value === val.trim());
      desc.textContent = preset ? preset.label : val;
    }

    if (input) {
      input.addEventListener('input', () => {
        updateDesc(input.value);
        onChange(input.value);
      });
      updateDesc(input.value);
    }

    container.querySelectorAll('.wf-cron-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        if (input) input.value = btn.dataset.value;
        updateDesc(btn.dataset.value);
        onChange(btn.dataset.value);
      });
    });
  },
};
