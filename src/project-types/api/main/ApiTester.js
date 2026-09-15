/** HTTP tester: bounded display response, total deadline and explicit cancellation. */
const http = require('http');
const https = require('https');
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_DURATION_MS = 30000;

class ApiTester {
  async sendRequest({ url, method = 'GET', headers = {}, body = '', signal, timeoutMs = MAX_DURATION_MS, maxBytes = MAX_RESPONSE_BYTES }) {
    const start = Date.now();
    return new Promise(resolve => {
      let req, response, timer, settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve({ status: 0, statusText: '', headers: {}, body: '', size: 0, time: Date.now() - start, ...result });
      };
      const fail = message => {
        finish({ error: message });
        response?.destroy(); req?.destroy();
      };
      const abort = () => fail('Request cancelled');
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => fail('Request exceeded total time limit'), Math.min(MAX_DURATION_MS, Math.max(1, timeoutMs)));
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported');
        const verb = method.toUpperCase();
        const requestHeaders = { ...headers };
        const hasBody = body && ['POST', 'PUT', 'PATCH'].includes(verb);
        if (hasBody) {
          requestHeaders['Content-Length'] = Buffer.byteLength(body);
          if (!Object.keys(requestHeaders).some(key => key.toLowerCase() === 'content-type')) {
            try { JSON.parse(body); requestHeaders['Content-Type'] = 'application/json'; }
            catch { requestHeaders['Content-Type'] = 'text/plain'; }
          }
        }
        req = (parsed.protocol === 'https:' ? https : http).request(parsed, { method: verb, headers: requestHeaders }, res => {
          response = res;
          const chunks = []; let size = 0;
          res.on('data', chunk => {
            size += chunk.length;
            if (size > Math.min(MAX_RESPONSE_BYTES, Math.max(1, maxBytes))) { fail('Response exceeds display size limit (5 MiB maximum)'); return; }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const responseHeaders = {};
            for (let i = 0; i < res.rawHeaders.length; i += 2) {
              const name = res.rawHeaders[i], value = res.rawHeaders[i + 1];
              responseHeaders[name] = responseHeaders[name] ? responseHeaders[name] + ', ' + value : value;
            }
            finish({ status: res.statusCode, statusText: res.statusMessage || '', headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8'), size });
          });
          res.on('aborted', () => fail('Connection aborted by server'));
          res.on('error', error => fail(error.message));
        });
        req.on('error', error => fail(error.message));
        req.end(hasBody ? body : undefined);
      } catch (error) { fail(error.message); }
    });
  }
}
module.exports = new ApiTester();
