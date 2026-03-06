'use strict';

module.exports = {
  type:     'workflow/http',
  title:    'HTTP',
  desc:     'Requête API',
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
      placeholder: '{"Authorization": "Bearer $token"}',
      showIf: (p) => ['POST','PUT','PATCH'].includes(p.method) },
    { type: 'textarea', key: 'body', label: 'wfn.http.body.label', mono: true,
      hint: 'wfn.http.body.hint',
      placeholder: '{"name": "John", "email": "john@example.com"}',
      showIf: (p) => ['POST','PUT','PATCH'].includes(p.method) },
  ],

  badge: (n) => n.properties.method || 'GET',
  badgeColor: (n) => ({
    GET:    '#22c55e',
    POST:   '#3b82f6',
    PUT:    '#f59e0b',
    PATCH:  '#a78bfa',
    DELETE: '#ef4444',
  }[n.properties.method] || '#22d3ee'),

  // NOTE: runHttpStep is not yet exported from WorkflowRunner (module.exports = WorkflowRunner class only).
  // This run() uses native fetch directly and will be wired to WorkflowRunner.runHttpStep in Task 9.
  async run(config, vars, signal) {
    // Minimal inline var resolution until WorkflowRunner exports resolveVars
    const resolveVars = (value, vars) => {
      if (typeof value !== 'string') return value;
      return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
        const parts = key.split('.');
        let cur = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
        return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
      });
    };

    const url    = resolveVars(config.url || '', vars);
    const method = (config.method || 'GET').toUpperCase();

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
    if (config.body) {
      const rawBody = resolveVars(config.body, vars);
      try { body = JSON.stringify(JSON.parse(rawBody)); } catch { body = rawBody; }
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
