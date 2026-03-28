/**
 * MarkdownRenderer - Public API
 * Re-exports all rendering functions from the modular markdown system.
 */

const { render, renderInline, configure } = require('./configure');
const { attachInteractivity } = require('./interactivity');
const { postProcess } = require('./postProcess');
const { createStreamCache, renderIncremental } = require('./streaming');

module.exports = {
  render,
  renderInline,
  configure,
  attachInteractivity,
  postProcess,
  createStreamCache,
  renderIncremental,
};
