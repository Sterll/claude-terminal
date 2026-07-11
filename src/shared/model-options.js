/**
 * model-options.js
 * Single source of truth for the Claude model / effort choices offered on the
 * `claude` workflow node. Consumed by the graph editor combo widgets
 * (WorkflowGraphEngine), the rich claude-config field, and the .node.js
 * validators (main process). Keep the three in sync via these exports.
 */

'use strict';

// Ordered list of accepted `model` property values ('' = inherit / auto).
const CLAUDE_MODEL_VALUES = [
  '',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'sonnet',
  'opus',
  'haiku',
];

// Human-readable labels, in the same order.
const MODEL_OPTIONS = [
  { value: '',                label: 'Default (inherit)' },
  { value: 'claude-fable-5',  label: 'Fable 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { value: 'sonnet',          label: 'Sonnet (alias)' },
  { value: 'opus',            label: 'Opus (alias)' },
  { value: 'haiku',           label: 'Haiku (alias)' },
];

// Ordered list of accepted `effort` property values ('' = inherit / auto).
const EFFORT_VALUES = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

const EFFORT_OPTIONS = [
  { value: '',       label: 'Default (inherit)' },
  { value: 'low',    label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High' },
  { value: 'xhigh',  label: 'XHigh' },
  { value: 'max',    label: 'Max' },
];

module.exports = {
  CLAUDE_MODEL_VALUES,
  MODEL_OPTIONS,
  EFFORT_VALUES,
  EFFORT_OPTIONS,
};
