/**
 * Entry point: registers all built-in mention sources on app init.
 * Called automatically from services/index.js on module load.
 */

const registry = require('../MentionSourceRegistry');

const kanbanSource       = require('./kanban.source');
const workflowSource     = require('./workflow.source');
const parallelSource     = require('./parallel.source');
const sessionSource      = require('./session.source');
const skillSource        = require('./skill.source');
const workspaceDocSource = require('./workspace-doc.source');

let _bootstrapped = false;

function bootstrap() {
  if (_bootstrapped) return;
  registry.register(kanbanSource);
  registry.register(workflowSource);
  registry.register(parallelSource);
  registry.register(sessionSource);
  registry.register(skillSource);
  registry.register(workspaceDocSource);
  _bootstrapped = true;
}

module.exports = { bootstrap, registry };
