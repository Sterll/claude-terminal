/**
 * UI Components - Central Export
 */

const Modal = require('./Modal');
const Toast = require('./Toast');
const ContextMenu = require('./ContextMenu');
const Tab = require('./Tab');
const ProjectList = require('./ProjectList');
const ProjectBar = require('./ProjectBar');
const TerminalManager = require('./TerminalManager');
const CustomizePicker = require('./CustomizePicker');
const QuickActions = require('./QuickActions');
const FileExplorer = require('./FileExplorer');

module.exports = {
  ...Modal,
  ...Toast,
  ...ContextMenu,
  ...Tab,
  ProjectList,
  ProjectBar,
  TerminalManager,
  CustomizePicker,
  QuickActions,
  FileExplorer
};
