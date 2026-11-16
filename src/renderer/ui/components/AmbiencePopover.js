/**
 * AmbiencePopover - the titlebar's ambience button: switch theme, sound and
 * animation, and enter zen mode without leaving the conversation.
 *
 * Like the Theme Studio it only writes settings; ThemeEngine applies them.
 * The theme strip reuses the studio's thumbnail painter at a small size.
 */

const ThemeEngine = require('../../ambience/ThemeEngine');
const { paintThumbnail } = require('../panels/ThemeStudio');
const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18c2.5-2 5-2 7.5 0s5 2 7.5 0"/><path d="M3 13.5c2.5-2 5-2 7.5 0s5 2 7.5 0"/><path d="M16 4.5a3.5 3.5 0 1 0 3.5 3.5A2.8 2.8 0 0 1 16 4.5z"/></svg>';

function themeLabel(theme) {
  if (theme.custom) return theme.name;
  const key = `ambience.theme.${theme.id}`;
  const v = t(key);
  return v === key ? theme.name : v;
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.anchor  element the button is inserted before
 * @param {object} deps.settingsState
 * @param {(key: string, value: any) => void} deps.setSetting
 */
function mountAmbiencePopover({ anchor, settingsState, setSetting }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'titlebar-ambience-btn';
  btn.innerHTML = ICON;
  btn.title = t('ambience.buttonLabel');
  btn.setAttribute('aria-label', t('ambience.buttonLabel'));
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  anchor.parentElement.insertBefore(btn, anchor);

  let pop = null;

  const close = () => {
    if (!pop) return;
    pop.remove();
    pop = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onOutside = (e) => { if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); } };

  const render = () => {
    const s = settingsState.get();
    const active = s.appTheme || 'classic';
    const themes = ThemeEngine.allThemes();
    pop.innerHTML = `
      <div class="amb-pop-head">
        <span>${t('ambience.quickTitle')}</span>
      </div>
      <div class="amb-pop-strip" role="listbox" aria-label="${t('ambience.galleryTitle')}">
        ${themes.map((th) => `
          <button type="button" role="option" aria-selected="${th.id === active}" class="amb-pop-theme ${th.id === active ? 'active' : ''}"
                  data-theme-id="${escapeHtml(th.id)}" title="${escapeHtml(themeLabel(th))}">
            <canvas width="132" height="75"></canvas>
            <span>${escapeHtml(themeLabel(th))}</span>
          </button>`).join('')}
      </div>
      <div class="amb-pop-row">
        <label class="amb-pop-switch"><input type="checkbox" data-key="ambientSoundEnabled" ${s.ambientSoundEnabled ? 'checked' : ''}><span>${t('ambience.quickSound')}</span></label>
        <input type="range" class="amb-pop-volume" min="0" max="1" step="0.05" value="${typeof s.ambientSoundVolume === 'number' ? s.ambientSoundVolume : 0.5}" aria-label="${t('ambience.volume')}">
      </div>
      <div class="amb-pop-row">
        <span class="amb-pop-label">${t('ambience.brightness')}</span>
        <input type="range" class="amb-pop-volume amb-pop-brightness" min="0.3" max="1" step="0.05" value="${typeof s.ambientBrightness === 'number' ? s.ambientBrightness : 0.7}" aria-label="${t('ambience.brightness')}">
      </div>
      <div class="amb-pop-row">
        <label class="amb-pop-switch"><input type="checkbox" data-key="ambientMotion" ${s.ambientMotion !== false ? 'checked' : ''}><span>${t('ambience.quickMotion')}</span></label>
        <label class="amb-pop-switch"><input type="checkbox" data-key="zenMode" ${s.zenMode ? 'checked' : ''}><span>${t('ambience.quickZen')}</span></label>
      </div>
      <button type="button" class="amb-pop-more">${t('ambience.quickMore')} →</button>`;

    // Thumbnails: paint the active one first, then the rest a few per frame.
    const cards = [...pop.querySelectorAll('.amb-pop-theme')];
    const byId = new Map(themes.map((th) => [th.id, th]));
    const queue = cards.sort((a, b) => (b.classList.contains('active') ? 1 : 0) - (a.classList.contains('active') ? 1 : 0));
    const step = () => {
      const start = performance.now();
      while (queue.length && performance.now() - start < 10) {
        const card = queue.shift();
        if (card.isConnected) paintThumbnail(card.querySelector('canvas'), byId.get(card.dataset.themeId));
      }
      if (queue.length && pop) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    pop.querySelector('.amb-pop-theme.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });

    pop.querySelectorAll('.amb-pop-theme').forEach((card) => {
      card.onclick = () => {
        ThemeEngine.selectTheme(card.dataset.themeId);
        pop.querySelectorAll('.amb-pop-theme').forEach((c) => {
          c.classList.toggle('active', c === card);
          c.setAttribute('aria-selected', String(c === card));
        });
      };
    });
    pop.querySelectorAll('input[type="checkbox"][data-key]').forEach((el) => {
      el.onchange = () => setSetting(el.dataset.key, el.checked);
    });
    pop.querySelector('.amb-pop-volume:not(.amb-pop-brightness)').oninput = (e) => setSetting('ambientSoundVolume', Number(e.target.value));
    pop.querySelector('.amb-pop-brightness').oninput = (e) => setSetting('ambientBrightness', Number(e.target.value));
    pop.querySelector('.amb-pop-more').onclick = () => {
      close();
      document.dispatchEvent(new CustomEvent('ct-open-settings', { detail: { tab: 'themes' } }));
    };
  };

  btn.onclick = () => {
    if (pop) { close(); return; }
    pop = document.createElement('div');
    pop.className = 'amb-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', t('ambience.quickTitle'));
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right - 8))}px`;
    btn.setAttribute('aria-expanded', 'true');
    render();
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  };

  return { button: btn, close };
}

module.exports = { mountAmbiencePopover };
