'use strict';

const { resolveVars, assertSafeUrl } = require('./_registry');

module.exports = {
  type:     'workflow/http',
  title:    'HTTP',
  desc:     'API request',
  color:    'cyan',
  width:    220,
  category: 'actions',
  icon:     'http',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',   type: 'exec'    },
    { name: 'Error',  type: 'exec'    },
    { name: 'body',   type: 'object'  },
    { name: 'status', type: 'number'  },
    { name: 'ok',     type: 'boolean' },
  ],

  props: { method: 'GET', url: '', headers: '', body: '' },

  fields: [
    { type: 'select', key: 'method', label: 'wfn.http.method.label',
      options: ['GET','POST','PUT','PATCH','DELETE'] },
    { type: 'text', key: 'url', label: 'wfn.http.url.label', mono: true,
      placeholder: 'https://api.example.com/v1/users' },
    { type: 'textarea', key: 'headers', label: 'wfn.http.headers.label', mono: true,
      hint: 'wfn.http.headers.hint',
      placeholder: '{"Authorization": "Bearer $token"}' },
    { type: 'textarea', key: 'body', label: 'wfn.http.body.label', mono: true,
      hint: 'wfn.http.body.hint',
      placeholder: '{"name": "John", "email": "john@example.com"}',
      showIf: (p) => ['POST','PUT','PATCH'].includes(p.method) },
    { type: 'number', key: 'timeout', label: 'Timeout (ms)',
      placeholder: '30000' },
  ],

  badge: (n) => n.properties.method || 'GET',
  badgeColor: (n) => ({
    GET:    '#22c55e',
    POST:   '#3b82f6',
    PUT:    '#f59e0b',
    PATCH:  '#a78bfa',
    DELETE: '#ef4444',
  }[n.properties.method] || '#22d3ee'),

  async run(config, vars, signal) {
    if (signal?.aborted) throw new Error('Aborted');

    const url    = String(resolveVars(config.url || '', vars) ?? '');
    const method = (config.method || 'GET').toUpperCase();

    // SSRF guard — only http/https to non-private hosts.
    assertSafeUrl(url);

    // Headers: accept JSON string or plain "Key: Value" lines
    let headers = {};
    if (config.headers) {
      const rawHeaders = resolveVars(config.headers, vars);
      try {
        headers = JSON.parse(rawHeaders);
      } catch {
        // "Key: Value" line format
        for (const line of rawHeaders.split('\n')) {
          const idx = line.indexOf(':');
          if (idx > 0) {
            const k = line.slice(0, idx).trim();
            const v = line.slice(idx + 1).trim();
            if (k) headers[k] = v;
          }
        }
      }
    }

    // Body: resolve vars then try JSON parse
    let body;
    let bodyIsJson = false;
    if (config.body) {
      const rawBody = String(resolveVars(config.body, vars) ?? '');
      try { body = JSON.stringify(JSON.parse(rawBody)); bodyIsJson = true; } catch { body = rawBody; }
    }

    // Auto Content-Type when the body is JSON and no header was provided.
    if (bodyIsJson && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    const timeout  = config.timeout ? Number(config.timeout) : 30_000;
    const aborter  = new AbortController();
    const timer    = setTimeout(() => aborter.abort(), timeout);
    const onAbort  = () => aborter.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res  = await fetch(url, { method, headers, body, signal: aborter.signal });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { /* keep as text */ }
      return { status: res.status, ok: res.ok, body: json ?? text };
    } catch (err) {
      if (signal?.aborted) throw new Error('Aborted');
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  },
};
