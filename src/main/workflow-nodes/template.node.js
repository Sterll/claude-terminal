'use strict';

const { resolveVars } = require('./_registry');

/**
 * Build a string.
 *
 * Until this node existed there was no way to combine two values into one piece
 * of text: `transform` reshapes arrays, `variable` stores a value verbatim, and
 * everything else consumes text rather than producing it. The workarounds were
 * a `shell` node running `echo` (a process spawn, and quoting hell across
 * platforms) or a `claude` node (a paid model call to concatenate two strings).
 *
 * Interpolation is the engine's own `$variable` syntax, so it behaves exactly
 * like every other field in a workflow — including the two quirks worth knowing:
 *   - an unresolved `$ref` *inside* a longer string collapses to empty, while
 *   - a template that is nothing but a single unresolved `$ref` stays literal.
 * Both are `resolveVars` semantics, pinned by the lab scenarios rather than
 * papered over here, so this node never disagrees with the rest of the engine.
 */

/**
 * Render a resolved value as text.
 * A single `$ref` template resolves to the raw value (array, object, number…),
 * so it has to be flattened here; objects become JSON rather than the
 * "[object Object]" that String() would produce.
 * @param {*} value
 * @returns {string}
 */
function toText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); }
    catch { return ''; }          // circular — emit nothing rather than throw
  }
  return String(value);
}

module.exports = {
  type:     'workflow/template',
  title:    'Template',
  desc:     'Build a string from a text template and $variables',
  color:    'teal',
  width:    240,
  category: 'data',
  icon:     'template',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',  type: 'exec'   },
    { name: 'Error', type: 'exec'   },
    { name: 'text',  type: 'string' },
  ],

  props: { template: '' },

  fields: [
    { type: 'textarea', key: 'template', label: 'wfn.template.template.label',
      hint: 'wfn.template.template.hint',
      placeholder: 'Deploy of $ctx.project on $branch finished with code $node_2.exitCode' },
  ],

  badge: () => 'TXT',
  drawExtra: (ctx, n) => {
    const tpl = n.properties.template;
    if (!tpl) return;
    ctx.fillStyle = '#444';
    ctx.font = '10px "Cascadia Code","Fira Code",monospace';
    ctx.textAlign = 'left';
    const oneLine = String(tpl).replace(/\s+/g, ' ');
    ctx.fillText(oneLine.length > 28 ? oneLine.slice(0, 28) + '...' : oneLine, 10, n.size[1] - 6);
  },

  async run(config, vars, signal) {
    if (signal?.aborted) throw new Error('Cancelled');

    const raw = config.template;
    // An empty template is always a misconfiguration: the node's only job is to
    // produce text. Failing here beats handing an empty string to a notify or
    // commit-message node three steps later.
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('Template node: no template configured');
    }

    return { text: toText(resolveVars(raw, vars)) };
  },
};
