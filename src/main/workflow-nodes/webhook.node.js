'use strict';

const { assertSafeUrl } = require('./_registry');

module.exports = {
  type:     'workflow/webhook',
  title:    'Webhook',
  desc:     'Send a message to a Slack / Discord / Teams webhook',
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
    { name: 'statusCode', type: 'number'  },
    { name: 'body',       type: 'string'  },
    { name: 'truncated',  type: 'boolean' },
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
    if (!url) throw new Error('Missing webhook URL');

    // Resolve $xxx variables — supports Maps and plain objects
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
      text: resolve(config.text) || 'Claude Terminal notification',
    };
    if (config.username) payload.username = config.username;
    if (config.icon)     payload.icon_emoji = config.icon;

    const body = JSON.stringify(payload);
    // SSRF guard — reject non-http(s) / private / loopback hosts.
    const parsed = assertSafeUrl(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const TIMEOUT_MS   = 15_000;
    const MAX_BODY     = 256 * 1024; // cap accumulated response body at 256 KB

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

      let onAbort = null;
      const cleanup = () => {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
      };

      const req = lib.request(options, (res) => {
        let data = '';
        let truncated = false;
        res.on('data', (chunk) => {
          if (data.length < MAX_BODY) {
            data += chunk;
            if (data.length > MAX_BODY) { data = data.slice(0, MAX_BODY); truncated = true; }
          } else {
            truncated = true;
          }
        });
        res.on('end', () => {
          cleanup();
          resolve({ statusCode: res.statusCode, body: data, truncated });
        });
      });

      req.setTimeout(TIMEOUT_MS, () => {
        req.destroy(new Error(`Webhook request timed out after ${TIMEOUT_MS}ms`));
      });

      req.on('error', (err) => { cleanup(); reject(err); });

      if (signal) {
        onAbort = () => req.destroy(new Error('Aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }

      req.write(body);
      req.end();
    });
  },
};
