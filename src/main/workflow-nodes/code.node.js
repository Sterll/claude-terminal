'use strict';

const {
  resolveVars, compileSandboxed, varsToPlainObject, SANDBOX_TIMEOUT_MS,
} = require('./_registry');

/**
 * The escape hatch.
 *
 * Every other node covers a case someone anticipated. Without this one, an
 * unanticipated case — join two values into a sentence, reshape an object, do
 * arithmetic across variables — had no home: `transform` only walks arrays, so
 * the alternatives were spawning a shell or paying for an LLM call to
 * concatenate two strings.
 *
 * The body is a function body (write your own `return`), not an expression, and
 * runs in the same hardened vm context as `transform` — see
 * _registry.compileSandboxed for the escape-hardening rationale and its limits.
 */
module.exports = {
  type:     'workflow/code',
  title:    'Code',
  desc:     'Run a snippet of JavaScript',
  color:    'cyan',
  width:    240,
  category: 'data',
  icon:     'code',

  inputs: [
    { name: 'In',    type: 'exec' },
    { name: 'input', type: 'any'  },
  ],
  outputs: [
    { name: 'Done',   type: 'exec' },
    { name: 'Error',  type: 'exec' },
    { name: 'result', type: 'any'  },
  ],

  props: { code: '', input: '', outputVar: '' },

  fields: [
    { type: 'textarea', key: 'code',
      label: 'wfn.code.code.label',
      hint:  'wfn.code.code.hint',
      placeholder: 'return `${vars.branch} has ${input.length} files`;' },
    { type: 'text', key: 'input',
      label: 'wfn.code.input.label',
      hint:  'wfn.code.input.hint',
      placeholder: '$node_2.rows' },
    { type: 'text', key: 'outputVar',
      label: 'wfn.code.outputVar.label',
      hint:  'wfn.code.outputVar.hint',
      placeholder: 'summary' },
  ],

  async run(config, vars, signal) {
    const body = String(config.code ?? '').trim();
    if (!body) throw new Error('Code node: no code to run');

    if (signal?.aborted) throw new Error('Cancelled');

    // `input` arrives either as a resolved data-pin value (the runner spreads
    // data inputs over the node properties) or as a `$var` reference typed into
    // the field. Only strings need resolving; a piped value is already data.
    let input = config.input;
    if (typeof input === 'string') {
      input = input.trim() ? resolveVars(input, vars) : undefined;
    }

    // Variables cross as plain JSON-safe data, never as live host objects.
    const fn = compileSandboxed(body, ['vars', 'input'], { statements: true, label: 'code' });
    const raw = fn(varsToPlainObject(vars), input);

    // Values built inside the vm carry SANDBOX prototypes, so `result instanceof
    // Array` is false downstream and deep comparisons behave oddly. Bring them
    // back into the host realm; this also enforces the node's JSON-safe
    // contract at the boundary rather than letting exotic values leak onward.
    let result;
    try {
      result = raw === undefined ? undefined : JSON.parse(JSON.stringify(raw));
    } catch (e) {
      throw new Error(`Code node returned a value that cannot be passed on: ${e.message}`);
    }

    const outputVar = String(config.outputVar ?? '').trim();
    if (outputVar) {
      if (vars instanceof Map) vars.set(outputVar, result);
      else vars[outputVar] = result;
    }

    return { result, success: true };
  },

  // Surfaced so the limits are visible from the node itself, not only in docs.
  meta: { timeoutMs: SANDBOX_TIMEOUT_MS },
};
