/**
 * Renderer Utilities - Central Export
 */

const dom = require('./dom');
const color = require('./color');
const paths = require('./paths');
const format = require('./format');
const fileIcons = require('./fileIcons');
const syntaxHighlight = require('./syntaxHighlight');
const notificationSounds = require('./notificationSounds');

module.exports = {
  ...dom,
  ...color,
  ...paths,
  ...format,
  ...fileIcons,
  ...syntaxHighlight,
  ...notificationSounds
};
