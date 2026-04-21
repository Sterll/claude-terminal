'use strict';

/**
 * notify_discord node
 * Sends a Discord webhook payload (content + optional embed).
 */
module.exports = {
  type:     'workflow/notify_discord',
  title:    'Discord notify',
  desc:     'Send a message to a Discord webhook',
  color:    'info',
  width:    240,
  category: 'actions',
  icon:     'bell',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',   type: 'exec'    },
    { name: 'Error',  type: 'exec'    },
    { name: 'status', type: 'number'  },
    { name: 'ok',     type: 'boolean' },
  ],

  props: {
    webhookUrl: '',
    content: '',
    title: '',
    description: '',
    color: '#5865F2',
    username: '',
  },

  fields: [
    { type: 'text', key: 'webhookUrl', label: 'wfn.discord.webhook.label', mono: true,
      hint: 'wfn.discord.webhook.hint',
      placeholder: 'https://discord.com/api/webhooks/...' },
    { type: 'text', key: 'username', label: 'wfn.discord.username.label',
      placeholder: 'Claude Terminal' },
    { type: 'textarea', key: 'content', label: 'wfn.discord.content.label',
      hint: 'wfn.discord.content.hint',
      placeholder: 'Build finished on $project.name' },
    { type: 'text', key: 'title', label: 'wfn.discord.title.label',
      placeholder: 'Deploy succeeded' },
    { type: 'textarea', key: 'description', label: 'wfn.discord.description.label',
      rows: 3 },
    { type: 'text', key: 'color', label: 'wfn.discord.color.label',
      placeholder: '#5865F2' },
  ],

  async run(config, vars, signal) {
    const resolveVars = (value) => {
      if (typeof value !== 'string') return value;
      return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
        const parts = key.split('.');
        let cur = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
        return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
      });
    };

    const url = resolveVars(config.webhookUrl || '').trim();
    if (!url) throw new Error('Discord webhook URL is required');
    if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url)) {
      throw new Error('Invalid Discord webhook URL');
    }

    const content     = resolveVars(config.content || '');
    const title       = resolveVars(config.title || '');
    const description = resolveVars(config.description || '');
    const username    = resolveVars(config.username || '').trim();
    const colorStr    = String(config.color || '').trim();

    const payload = {};
    if (username) payload.username = username;
    if (content)  payload.content  = content;
    if (title || description) {
      const embed = {};
      if (title)       embed.title       = title;
      if (description) embed.description = description;
      if (colorStr) {
        const hex = colorStr.startsWith('#') ? colorStr.slice(1) : colorStr;
        const n = parseInt(hex, 16);
        if (Number.isFinite(n)) embed.color = n;
      }
      embed.timestamp = new Date().toISOString();
      payload.embeds = [embed];
    }
    if (!payload.content && !payload.embeds) {
      throw new Error('Discord payload requires content or embed');
    }

    const aborter = new AbortController();
    const onAbort = () => aborter.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: aborter.signal,
      });
      if (!res.ok && res.status !== 204) {
        const text = await res.text().catch(() => '');
        throw new Error(`Discord webhook ${res.status}: ${text.slice(0, 200)}`);
      }
      return { status: res.status, ok: res.ok };
    } catch (err) {
      if (signal?.aborted) throw new Error('Aborted');
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  },
};
