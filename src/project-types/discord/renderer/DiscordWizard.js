/**
 * Discord Bot Wizard
 * Project creation wizard fields and scaffold templates
 */

const { t } = require('../../../renderer/i18n');

const DISCORD_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>';
const PYTHON_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c-1.66 0-3.26.13-4.53.36C5.48 2.72 4.5 3.67 4.5 5v2.5C4.5 8.88 5.62 10 7 10h5c.55 0 1 .45 1 1v1H6c-1.66 0-3.11 1.28-3.11 2.94l-.01.06v3c0 1.33 1.02 2.44 2.37 2.72C6.6 21.14 8.23 21.5 10 21.5h4c1.66 0 3-1.34 3-3v-2.5c0-1.38-1.12-2.5-2.5-2.5H9.5c-.55 0-1-.45-1-1v-1h8c1.66 0 3-1.34 3-3V5.5c0-1.33-1.02-2.44-2.37-2.72C15.78 2.36 13.99 2 12 2zM9 4.5a1 1 0 110 2 1 1 0 010-2zm6 13a1 1 0 110 2 1 1 0 010-2z"/></svg>';

const SCAFFOLD_TEMPLATES = [
  {
    id: 'discordjs',
    name: 'Discord.js v14',
    icon: DISCORD_ICON,
    color: '#5865F2',
    description: 'Slash commands, events, handlers',
    cmd: (name, pm) => {
      const install = pm === 'bun' ? 'bun add' : pm === 'pnpm' ? 'pnpm add' : pm === 'yarn' ? 'yarn add' : 'npm install';
      return `mkdir "${name}" && cd "${name}" && ${pm === 'bun' ? 'bun' : pm} init -y && ${install} discord.js`;
    }
  },
  {
    id: 'discordpy',
    name: 'discord.py',
    icon: PYTHON_ICON,
    color: '#3776AB',
    description: 'Cogs, slash commands, Python',
    cmd: (name) => {
      if (process.platform === 'win32') {
        return `mkdir "${name}" && cd "${name}" && python -m venv venv && venv\\Scripts\\pip install discord.py`;
      }
      return `mkdir "${name}" && cd "${name}" && python3 -m venv venv && venv/bin/pip install discord.py`;
    }
  },
  {
    id: 'eris',
    name: 'Eris',
    icon: DISCORD_ICON,
    color: '#7289DA',
    description: 'Lightweight alternative, fast',
    cmd: (name, pm) => {
      const install = pm === 'bun' ? 'bun add' : pm === 'pnpm' ? 'pnpm add' : pm === 'yarn' ? 'yarn add' : 'npm install';
      return `mkdir "${name}" && cd "${name}" && ${pm === 'bun' ? 'bun' : pm} init -y && ${install} eris`;
    }
  }
];

function getWizardFields() {
  return `
    <div class="discord-config" style="display:none;">
      <div class="wizard-field">
        <label class="wizard-label">${t('discord.startCommand')}</label>
        <input type="text" id="inp-discord-cmd" class="wizard-input" placeholder="node bot.js" />
        <span class="wizard-hint">${t('discord.startCommandHint')}</span>
      </div>
    </div>
  `;
}

function onWizardTypeSelected(form, isSelected) {
  const config = form.querySelector('.discord-config');
  if (config) config.style.display = isSelected ? 'block' : 'none';
}

function bindWizardEvents(form, api) {
  // No special bindings needed
}

function getWizardConfig(form) {
  return {
    startCommand: form.querySelector('#inp-discord-cmd')?.value || ''
  };
}

function getTemplateGridHtml(translate) {
  const tFn = translate || t;
  return SCAFFOLD_TEMPLATES.map(tmpl => `
    <div class="scaffold-template-card" data-template-id="${tmpl.id}" tabindex="0">
      <div class="scaffold-template-icon" style="color: ${tmpl.color}">${tmpl.icon}</div>
      <div class="scaffold-template-info">
        <div class="scaffold-template-name">${tmpl.name}</div>
        <div class="scaffold-template-desc">${tmpl.description}</div>
      </div>
    </div>
  `).join('');
}

function detectFramework(pkg) {
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps['discord.js']) return { name: 'discord.js', icon: 'discord' };
  if (deps['eris']) return { name: 'Eris', icon: 'discord' };
  if (deps['oceanic.js']) return { name: 'Oceanic.js', icon: 'discord' };
  return null;
}

module.exports = {
  getWizardFields,
  onWizardTypeSelected,
  bindWizardEvents,
  getWizardConfig,
  getTemplateGridHtml,
  detectFramework,
  SCAFFOLD_TEMPLATES
};
