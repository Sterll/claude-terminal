'use strict';

module.exports = {
  type:     'workflow/webhook',
  title:    'Webhook',
  desc:     'Envoie un message à un webhook Slack / Discord / Teams',
  color:    'purple',
  width:    220,
  category: 'actions',
  icon:     'webhook',

  inputs: [
    { name: 'In', type: 'exec' },
  ],
  outputs: [
    { name: 'Done',       type: 'exec' },
    { name: 'Error',      type: 'exec' },
    { name: 'statusCode', type: 'number' },
    { name: 'body',       type: 'string' },
  ],

  props: {
    url: '',
    text: '',
    username: '',
    icon: '',
  },

  fields: [
    {
      type: 'text',
      key: 'url',
      label: 'wfn.webhook.url.label',
      mono: true,
      placeholder: 'https://hooks.slack.com/services/...',
    },
    {
      type: 'textarea',
      key: 'text',
      label: 'wfn.webhook.text.label',
      rows: 3,
      placeholder: '$ctx.project build completed ✅',
      hint: 'wfn.webhook.text.hint',
    },
    {
      type: 'text',
      key: 'username',
      label: 'wfn.webhook.username.label',
      placeholder: 'Claude Terminal',
    },
    {
      type: 'text',
      key: 'icon',
      label: 'wfn.webhook.icon.label',
      placeholder: ':robot_face:',
    },
  ],

  badge: () => '🔗',

  async run(config, vars, signal) {
    const https = require('https');
    const http  = require('http');
    const url   = config.url;
    if (!url) throw new Error('URL du webhook manquante');

    // Résolution des variables $xxx — supporte Map et objets
    function resolve(str) {
      if (!str || typeof str !== 'string') return str;
      return str.replace(/\$(\w+(?:\.\w+)*)/g, (match, keyPath) => {
        const parts = keyPath.split('.');
        let val = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && val != null; i++) val = val[parts[i]];
        return val != null ? String(val) : match;
      });
    }

    const payload = {
      text: resolve(config.text) || 'Notification de Claude Terminal',
    };
    if (config.username) payload.username = config.username;
    if (config.icon)     payload.icon_emoji = config.icon;

    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Aborted'));

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data });
        });
      });

      req.on('error', reject);
      if (signal) signal.addEventListener('abort', () => req.destroy(new Error('Aborted')));
      req.write(body);
      req.end();
    });
  },
};
