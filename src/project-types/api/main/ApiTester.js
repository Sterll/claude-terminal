/** HTTP tester: bounded preview, cancellable streaming and atomic disk output. */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DISK_PREVIEW_BYTES = 64 * 1024;

class ApiTester {
  async sendRequest({ url, method = 'GET', headers = {}, body = '', signal, timeoutMs, maxBytes = MAX_RESPONSE_BYTES, saveToPath, onProgress }) {
    const start = Date.now();
    const deadline = new AbortController();
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const maximum = saveToPath ? 30 * 60 * 1000 : 30000;
    const timer = setTimeout(() => deadline.abort(), Math.min(maximum, Math.max(1, Number(timeoutMs) || maximum)));
    let temporary, req, response, size = 0;
    try {
      combined.throwIfAborted();
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported');
      const verb = method.toUpperCase(), requestHeaders = { ...headers };
      const hasBody = body && ['POST', 'PUT', 'PATCH'].includes(verb);
      if (hasBody) {
        requestHeaders['Content-Length'] = Buffer.byteLength(body);
        if (!Object.keys(requestHeaders).some(key => key.toLowerCase() === 'content-type')) {
          try { JSON.parse(body); requestHeaders['Content-Type'] = 'application/json'; }
          catch { requestHeaders['Content-Type'] = 'text/plain'; }
        }
      }
      response = await new Promise((resolve, reject) => {
        req = (parsed.protocol === 'https:' ? https : http).request(parsed, { method: verb, headers: requestHeaders, signal: combined }, resolve);
        req.on('error', reject);
        req.end(hasBody ? body : undefined);
      });
      const preview = [], limit = saveToPath ? DISK_PREVIEW_BYTES : Math.min(MAX_RESPONSE_BYTES, Math.max(1, maxBytes));
      let previewSize = 0, lastProgress = 0;
      const total = Number(response.headers['content-length']) || null;
      const measure = new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (!saveToPath && size > limit) { callback(new Error('Response exceeds display size limit (5 MiB maximum); save the response to disk')); return; }
        if (previewSize < limit) {
          const part = Buffer.from(chunk.subarray(0, limit - previewSize)); preview.push(part); previewSize += part.length;
        }
        if (Date.now() - lastProgress >= 150) { onProgress?.({ size, total }); lastProgress = Date.now(); }
        callback(null, chunk);
      } });
      let output;
      if (saveToPath) {
        temporary = path.join(path.dirname(saveToPath), `.ct-http-${randomUUID()}.tmp`);
        output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
      } else output = new Writable({ write(_chunk, _encoding, done) { done(); } });
      await pipeline(response, measure, output, { signal: combined });
      combined.throwIfAborted();
      if (saveToPath) { await fs.promises.rename(temporary, saveToPath); temporary = null; }
      onProgress?.({ size, total });
      const responseHeaders = {};
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        const name = response.rawHeaders[i], value = response.rawHeaders[i + 1];
        responseHeaders[name] = responseHeaders[name] ? responseHeaders[name] + ', ' + value : value;
      }
      return { status: response.statusCode, statusText: response.statusMessage || '', headers: responseHeaders,
        body: Buffer.concat(preview).toString('utf8'), size, time: Date.now() - start,
        ...(saveToPath ? { savedPath: saveToPath, previewTruncated: size > previewSize } : {}) };
    } catch (error) {
      req?.destroy(); response?.destroy();
      return { status: 0, statusText: '', headers: {}, body: '', size, time: Date.now() - start,
        cancelled: !!signal?.aborted, error: signal?.aborted ? 'Request cancelled' : deadline.signal.aborted ? 'Request exceeded total time limit' : error.message };
    } finally {
      clearTimeout(timer);
      if (temporary) await fs.promises.rm(temporary, { force: true });
    }
  }
}
module.exports = new ApiTester();
