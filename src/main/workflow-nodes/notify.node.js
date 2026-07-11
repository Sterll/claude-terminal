'use strict';

const { resolveVars, assertSafeUrl } = require('./_registry');

module.exports = {
  type:     'workflow/notify',
  title:    'Notify',
  desc:     'Notification',
  color:    'orange',
  width:    200,
  category: 'actions',
  icon:     'notify',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [{ name: 'Done', type: 'exec' }],

  props: { title: '', message: '', channels: 'desktop' },

  fields: [
    { type: 'text',     key: 'title',   label: 'wfn.notify.title.label',   placeholder: 'Build done' },
    { type: 'textarea', key: 'message', label: 'wfn.notify.message.label',
      hint: 'wfn.notify.message.hint',
      placeholder: '$ctx.project build completed successfully.' },
    // Channels: one per line. Either "desktop" or "discord=<webhook url>" /
    // "slack=<webhook url>". Backward-compatible with the legacy array form
    // (['desktop', { discord: 'https://...' }]).
    { type: 'textarea', key: 'channels', label: 'Channels',
      hint: 'One per line: desktop, discord=<url>, slack=<url>',
      placeholder: 'desktop\ndiscord=https://discord.com/api/webhooks/...' },
  ],

  async run(config, vars, signal, ctx) {
    const title   = String(resolveVars(config.title   || 'Workflow', vars) ?? '');
    const message = String(resolveVars(config.message || '',         vars) ?? '');

    // Normalise channels into a list of { type, url? } descriptors.
    // Accepts: array (legacy) | newline/comma string | undefined.
    const parseChannels = (raw) => {
      if (Array.isArray(raw)) {
        return raw.map(ch => {
          if (typeof ch === 'string') return { type: ch };
          if (ch && typeof ch === 'object') {
            const [type, url] = Object.entries(ch)[0] || [];
            return { type, url };
          }
          return null;
        }).filter(Boolean);
      }
      if (typeof raw === 'string' && raw.trim()) {
        return raw.split(/[\n,]/).map(line => {
          const s = line.trim();
          if (!s) return null;
          const eq = s.indexOf('=');
          if (eq > 0) return { type: s.slice(0, eq).trim().toLowerCase(), url: s.slice(eq + 1).trim() };
          return { type: s.toLowerCase() };
        }).filter(Boolean);
      }
      return [{ type: 'desktop' }];
    };

    const channels = parseChannels(config.channels);

    const postJson = async (url, bodyObj, type) => {
      try {
        assertSafeUrl(url);
      } catch (err) {
        console.warn(`[notify.node] ${type} blocked:`, err.message);
        return;
      }
      const aborter = new AbortController();
      const timer   = setTimeout(() => aborter.abort(), 15_000);
      const onAbort = () => aborter.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(bodyObj),
          signal:  aborter.signal,
        });
      } catch (err) {
        console.warn(`[notify.node] ${type} failed:`, err.message);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    };

    const tasks = [];
    for (const ch of channels) {
      if (!ch || !ch.type) continue;
      if (ch.type === 'desktop') {
        if (ctx?.sendFn) ctx.sendFn('workflow-notify-desktop', { title, message });
        continue;
      }
      const url = String(resolveVars(ch.url || '', vars) ?? '').trim();
      if (!url || url.startsWith('$')) continue;
      let bodyObj;
      if (ch.type === 'discord')     bodyObj = { content: message };
      else if (ch.type === 'slack')  bodyObj = { text: message };
      else                           bodyObj = { message };
      tasks.push(postJson(url, bodyObj, ch.type));
    }

    await Promise.allSettled(tasks);
    return { sent: true, message };
  },
};
