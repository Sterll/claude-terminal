/**
 * HTML Preview IPC Handler
 *
 * Serves the content of ```html markdown blocks over a dedicated `ct-preview://`
 * scheme instead of a `blob:` URL.
 *
 * Why a custom scheme: `blob:` (and `data:`, and `srcdoc`) documents inherit the
 * CSP of the page that created them. The renderer runs under a strict CSP
 * (`frame-src 'none'`, no `'unsafe-inline'` for scripts), so a blob preview was
 * either blocked outright or rendered with all of its inline scripts stripped —
 * i.e. a blank white iframe. A document served by a custom scheme carries its
 * own CSP header, so the preview can run its own styles/scripts without
 * loosening the CSP of the app itself.
 */

'use strict';

const { ipcMain, protocol } = require('electron');
const crypto = require('crypto');

const SCHEME = 'ct-preview';

// CSP applied to the preview document itself. Permissive enough to render what
// Claude generates (inline styles/scripts, CDN assets), but the document lives
// on an opaque origin in a sandboxed iframe and cannot phone home or navigate.
const PREVIEW_CSP = [
  "default-src 'self' data: blob: https:",
  "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'unsafe-inline' https: data: blob:",
  "img-src * data: blob:",
  "font-src * data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
].join('; ');

// Bounded LRU of live previews. Each rendered ```html block registers once;
// re-rendering a conversation registers again, so the map must not grow forever.
const MAX_PREVIEWS = 200;
const previews = new Map();

function storePreview(html) {
  const id = crypto.randomUUID();
  previews.set(id, String(html ?? ''));
  while (previews.size > MAX_PREVIEWS) {
    previews.delete(previews.keys().next().value);
  }
  return id;
}

const NOT_FOUND = '<!DOCTYPE html><html><body></body></html>';

/**
 * Register the `ct-preview` scheme as privileged.
 * Must run before `app.whenReady()`.
 */
function registerPreviewScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

/**
 * Wire the scheme handler. Must run after `app.whenReady()`.
 */
function registerPreviewProtocol() {
  protocol.handle(SCHEME, (request) => {
    let id = '';
    try {
      id = new URL(request.url).pathname.replace(/^\/+/, '');
    } catch { /* malformed URL → serve the empty document */ }
    const html = previews.get(id);
    return new Response(html ?? NOT_FOUND, {
      status: html === undefined ? 404 : 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': PREVIEW_CSP,
      },
    });
  });
}

function registerPreviewHandlers() {
  /**
   * 'preview:register'
   * Store a preview document and return the URL to point an iframe at.
   * @param {string} html
   * @returns {{ url: string } | { error: string }}
   */
  ipcMain.handle('preview:register', (_event, html) => {
    try {
      return { url: `${SCHEME}://p/${storePreview(html)}` };
    } catch (err) {
      return { error: err.message };
    }
  });
}

module.exports = {
  SCHEME,
  registerPreviewScheme,
  registerPreviewProtocol,
  registerPreviewHandlers,
};
