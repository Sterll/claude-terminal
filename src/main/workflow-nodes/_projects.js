// src/main/workflow-nodes/_projects.js
'use strict';

/**
 * Project record lookup for workflow nodes.
 *
 * `_registry.resolveProjectPath()` answers "where on disk does this workflow
 * run?", which is all a shell/git node needs. Nodes that talk to the UI need
 * more than a path: the renderer routes terminals by project **id**, and quick
 * actions live on the project **record**. Resolving that twice, differently, in
 * two node files is how the two ends drift apart — so it lives here.
 *
 * Underscore-prefixed, so `loadRegistry()` skips it (it is not a node).
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { resolveProjectPath } = require('./_registry');

/** Absolute path of the projects database the app writes. */
function projectsFile() {
  return path.join(os.homedir(), '.claude-terminal', 'projects.json');
}

/**
 * Read the project list. A missing, unreadable or corrupt projects.json yields
 * an empty list rather than throwing: a first-run install must fail the lookup
 * with a useful message, not with a JSON parse error.
 * @returns {Array<Object>}
 */
function loadProjects() {
  try {
    const data = JSON.parse(fs.readFileSync(projectsFile(), 'utf8'));
    return Array.isArray(data.projects) ? data.projects : [];
  } catch {
    return [];
  }
}

function _samePath(a, b) {
  if (!a || !b) return false;
  try {
    return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Resolve a project reference to its full record in projects.json.
 *
 * Matching order:
 *   1. exact id, exact name, exact folder name (what the MCP tools accept);
 *   2. whatever `resolveProjectPath()` resolves to — which also covers the
 *      empty reference, i.e. "the project this run belongs to". That fallback
 *      is what keeps a cron-triggered workflow with an empty project picker
 *      working instead of silently targeting nothing.
 *
 * @param {string} ref            id, name, folder name or absolute path
 * @param {Map|Object} vars       workflow variables (for the $ctx fallback)
 * @returns {Object|null}         the project record, or null when unknown
 */
function findProjectRecord(ref, vars) {
  const projects = loadProjects();
  const needle   = String(ref || '').trim().toLowerCase();

  if (needle) {
    const direct = projects.find(p =>
      p.id === ref ||
      (p.name || '').toLowerCase() === needle ||
      path.basename(p.path || '').toLowerCase() === needle
    );
    if (direct) return direct;
  }

  const resolvedPath = resolveProjectPath(String(ref || ''), vars);
  if (!resolvedPath) return null;
  return projects.find(p => _samePath(p.path, resolvedPath)) || null;
}

/** Display name for a project record, falling back to its folder name. */
function projectLabel(project) {
  return project?.name || path.basename(project?.path || '') || project?.id || '';
}

/**
 * Refuse a remote (SSH) project for a node that runs on this machine.
 *
 * Nodes that execute or read locally (shell, git, file, claude, terminal,
 * session_recap, parallel_spawn) cannot target a project whose files live on
 * another host: a URI never exists locally, so without this they would fail
 * with a misleading "path not found" or, worse, fall back to the home
 * directory. Each argument is checked on its own and may be:
 *   - an ssh-remote:// URI (a resolved cwd, `$ctx.project`, a custom path);
 *   - a project id or exact name, as the project pickers store it, which is
 *     refused when it names a remote project in projects.json.
 * Anything else (a local path, an empty value, an unknown reference) passes
 * untouched, so local resolution and its error messages do not move.
 *
 * @param {...*} refs
 * @throws {Error} refusalError('workflowNodes'), code REMOTE_UNSUPPORTED
 */
function assertLocalTargets(...refs) {
  const { assertLocalPaths, isRemoteProject, refusalError } = require('../../shared/remote-capabilities');
  const names = [];
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref.trim()) continue;
    assertLocalPaths('workflowNodes', ref.trim());
    names.push(ref.trim());
  }
  if (!names.length) return;
  const projects = loadProjects();
  for (const ref of names) {
    const needle = ref.toLowerCase();
    const record = projects.find(p => p.id === ref || (p.name || '').toLowerCase() === needle);
    if (record && isRemoteProject(record)) throw refusalError('workflowNodes');
  }
}

module.exports = { projectsFile, loadProjects, findProjectRecord, projectLabel, assertLocalTargets };
