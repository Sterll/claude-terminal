'use strict';

/**
 * Issue tracker IPC: providers, connections, reading and writing tickets,
 * and which tickets each Claude session is linked to.
 *
 * Keys go one way. The renderer hands a key over once, to `connect`; nothing
 * here ever sends one back, only a masked form. Errors keep their tracker
 * `code`, because Electron drops custom properties from a thrown error and the
 * UI words AUTH, RATE_LIMITED and NETWORK differently.
 */

const { ipcMain } = require('electron');
const issueTrackers = require('../services/IssueTrackerService');
const issueLinks = require('../services/IssueLinkService');
const issueDetection = require('../services/IssueDetectionService');

function fail(err) {
  // Logged so ErrorLogService keeps it: the renderer only gets a code, and a
  // failure nobody can read afterwards cannot be diagnosed.
  console.warn(`[IssueTrackers] ${err.code || 'PROVIDER'}: ${err.message}`);
  return { ok: false, error: err.message, code: err.code || 'PROVIDER', retryAfterMs: err.retryAfterMs };
}

function registerIssueTrackerHandlers() {
  ipcMain.handle('issue-trackers:providers', async () => {
    try {
      return { ok: true, providers: issueTrackers.listProviders() };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('issue-trackers:connections', async () => {
    try {
      return { ok: true, connections: await issueTrackers.listConnections() };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('issue-trackers:connect', async (_event, provider, secret) => {
    try {
      return { ok: true, connection: await issueTrackers.connect(provider, secret) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('issue-trackers:disconnect', async (_event, connectionId) => {
    try {
      await issueTrackers.disconnect(connectionId);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('issue-trackers:test', async (_event, connectionId) => {
    try {
      return { ok: true, connection: await issueTrackers.test(connectionId) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('issue-trackers:metadata', async (_event, connectionId, opts = {}) => {
    try {
      return { ok: true, metadata: await issueTrackers.metadata(connectionId, { refresh: !!opts.refresh }) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('issue-trackers:list-issues', async (_event, connectionId, query, cursor) => {
    try {
      return { ok: true, ...(await issueTrackers.listIssues(connectionId, query, cursor)) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('issue-trackers:get-issue', async (_event, connectionId, key) => {
    try {
      return { ok: true, issue: await issueTrackers.getIssue(connectionId, key) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('issue-trackers:update-issue', async (_event, connectionId, key, patch) => {
    try {
      return { ok: true, issue: await issueTrackers.updateIssue(connectionId, key, patch) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('issue-trackers:add-comment', async (_event, connectionId, key, body) => {
    try {
      return { ok: true, comment: await issueTrackers.addComment(connectionId, key, body) };
    } catch (err) {
      return fail(err);
    }
  });

  // ── Session ↔ ticket links ──
  const linkHandler = (fn) => async (_event, ...args) => {
    try {
      return { ok: true, ...(await fn(...args)) };
    } catch (err) {
      return fail(err);
    }
  };
  ipcMain.handle('issue-links:get', linkHandler(async (key) => ({ links: await issueLinks.get(key) })));
  ipcMain.handle('issue-links:link', linkHandler(async (key, link, opts) => ({ links: await issueLinks.link(key, link, opts || {}) })));
  ipcMain.handle('issue-links:confirm', linkHandler(async (key, refs) => ({ links: await issueLinks.confirm(key, refs) })));
  ipcMain.handle('issue-links:dismiss', linkHandler(async (key, refs) => ({ links: await issueLinks.dismiss(key, refs) })));
  ipcMain.handle('issue-links:rekey', linkHandler(async (from, to) => ({ moved: await issueLinks.rekey(from, to) })));
  ipcMain.handle('issue-links:copy', linkHandler(async (from, to) => ({ copied: await issueLinks.copy(from, to) })));
  ipcMain.handle('issue-links:counts', linkHandler(async () => ({ counts: await issueLinks.counts() })));
  // Text the renderer knows and main does not: a chat prompt as typed, the branch, the PR title.
  ipcMain.handle('issue-links:observe-text', linkHandler(async (key, text, source, evidence) => ({
    suggested: await issueDetection.service().observeText(key, text, source, evidence),
  })));

  // Claude's tracker tool calls in chat sessions. Terminal sessions come through the hooks.
  issueDetection.service().attachChat(require('../services/ChatService'));
}

module.exports = { registerIssueTrackerHandlers };
