/**
 * API Tester
 * Executes HTTP requests and returns structured results with timing.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

class ApiTester {
  /**
   * Send an HTTP request
   * @param {Object} params
   * @param {string} params.url - Full URL
   * @param {string} params.method - HTTP method
   * @param {Object} params.headers - Request headers
   * @param {string} params.body - Request body (string)
   * @returns {Promise<Object>} { status, statusText, headers, body, time, size }
   */
  async sendRequest({ url, method, headers = {}, body = '' }) {
    return new Promise((resolve) => {
      const startTime = Date.now();

      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        resolve({ error: `Invalid URL: ${url}`, status: 0, time: 0 });
        return;
      }

      const isHttps = parsed.protocol === 'https:';
      const transport = isHttps ? https : http;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: method.toUpperCase(),
        headers: { ...headers },
        timeout: 30000,
        rejectUnauthorized: false
      };

      // Set content-length for body
      if (body && ['POST', 'PUT', 'PATCH'].includes(options.method)) {
        const bodyBuf = Buffer.from(body, 'utf8');
        options.headers['Content-Length'] = bodyBuf.length;
        if (!options.headers['Content-Type']) {
          // Try to detect if body is JSON
          try {
            JSON.parse(body);
            options.headers['Content-Type'] = 'application/json';
          } catch (e) {
            options.headers['Content-Type'] = 'text/plain';
          }
        }
      }

      const req = transport.request(options, (res) => {
        const chunks = [];

        res.on('data', chunk => chunks.push(chunk));

        res.on('end', () => {
          const elapsed = Date.now() - startTime;
          const rawBody = Buffer.concat(chunks);
          const bodyStr = rawBody.toString('utf8');

          // Collect response headers as plain object
          const resHeaders = {};
          const rawHeaders = res.rawHeaders || [];
          for (let i = 0; i < rawHeaders.length; i += 2) {
            const key = rawHeaders[i];
            const val = rawHeaders[i + 1];
            if (resHeaders[key]) {
              resHeaders[key] += ', ' + val;
            } else {
              resHeaders[key] = val;
            }
          }

          resolve({
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers: resHeaders,
            body: bodyStr,
            time: elapsed,
            size: rawBody.length
          });
        });
      });

      req.on('error', (err) => {
        const elapsed = Date.now() - startTime;
        resolve({
          error: err.message,
          status: 0,
          statusText: 'Error',
          headers: {},
          body: '',
          time: elapsed,
          size: 0
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const elapsed = Date.now() - startTime;
        resolve({
          error: 'Request timed out (30s)',
          status: 0,
          statusText: 'Timeout',
          headers: {},
          body: '',
          time: elapsed,
          size: 0
        });
      });

      if (body && ['POST', 'PUT', 'PATCH'].includes(options.method)) {
        req.write(body);
      }

      req.end();
    });
  }
}

module.exports = new ApiTester();
