'use strict';

const _triggers = new Map();

/**
 * Charge tous les trigger UI renderers.
 * (Pas de fs.readdirSync en renderer bundlé esbuild — require manuel)
 */
function loadAll() {
  const defs = [
    require('./manual.trigger'),
    require('./cron.trigger'),
    require('./hook.trigger'),
    require('./on_workflow.trigger'),
    require('./webhook.trigger'),
    require('./file_change.trigger'),
    require('./terminal_exit_code.trigger'),
    require('./project_opened.trigger'),
    require('./claude_session_start.trigger'),
    require('./claude_session_end.trigger'),
    require('./git_event.trigger'),
    require('./chat_message.trigger'),
  ];
  for (const def of defs) {
    if (def.type) _triggers.set(def.type, def);
  }
}

function get(type)  { return _triggers.get(type); }
function getAll()   { return [..._triggers.values()]; }
function has(type)  { return _triggers.has(type); }

module.exports = { loadAll, get, getAll, has };
