'use strict';
const { Worker } = require('node:worker_threads');
const { resolveVars } = require('./workflow-variables');

// A user regex never runs on the main thread. The worker is terminated on timeout.
function matches(input, pattern) {
  if (input.length > 10000 || pattern.length > 1000) return Promise.resolve(false);
  return new Promise(resolve => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      try { parentPort.postMessage(new RegExp(workerData.pattern).test(workerData.input)); }
      catch { parentPort.postMessage(false); }`, { eval: true, workerData: { input, pattern } });
    const timer = setTimeout(() => finish(false), 1000);
    let finished = false;
    function finish(value) {
      if (finished) return;
      finished = true; clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(value);
    }
    worker.once('message', finish);
    worker.once('error', () => finish(false));
    worker.once('exit', () => finish(false));
  });
}

function text(value) { return value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); }
function isEmpty(value) {
  return value == null || value === '' || value === 'null' || value === 'undefined' || value === '[]' || value === '{}' ||
    (typeof value === 'object' && Object.keys(value).length === 0);
}
async function compare(left, op, right) {
  if (op === 'is_empty') return isEmpty(left);
  if (op === 'is_not_empty') return !isEmpty(left);
  const l = text(left), r = text(right);
  const numeric = value => /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value) && Number.isFinite(Number(value));
  const [a, b] = numeric(l) && numeric(r) ? [Number(l), Number(r)] : [l, r];
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    case 'contains': return l.includes(r);
    case 'starts_with': return l.startsWith(r);
    case 'ends_with': return l.endsWith(r);
    case 'matches': return matches(l, r);
    default: return false;
  }
}

async function evalCondition(condition, vars) {
  if (condition == null || condition === '') return true;
  if (typeof condition !== 'string') return Boolean(condition);
  if (!condition.trim()) return true;
  // Parse operators BEFORE variable interpolation so values remain operands.
  const unary = condition.match(/^(.*?)\s+(is_empty|is_not_empty)$/s);
  if (unary) return compare(resolveVars(unary[1].trim(), vars), unary[2]);
  const binary = condition.match(/^(.*?)\s*(==|!=|>=|<=|>|<)\s*(.*)$/s) ||
    condition.match(/^(.*?)\s+(contains|starts_with|ends_with|matches)\s+(.*)$/s);
  if (binary) return compare(resolveVars(binary[1].trim(), vars), binary[2], resolveVars(binary[3].trim(), vars));
  const resolved = resolveVars(condition, vars);
  return !isEmpty(resolved) && !['false', '0'].includes(text(resolved));
}

async function runConditionStep(config, vars) {
  const expressionMode = config._condMode === 'expression' || (!config._condMode && config.expression);
  const result = expressionMode || !('variable' in config)
    ? await evalCondition(config.expression || 'true', vars)
    : await compare(resolveVars(config.variable, vars), config.operator || '==', resolveVars(config.value ?? '', vars));
  return { result, value: result };
}
module.exports = { evalCondition, runConditionStep, matches };
