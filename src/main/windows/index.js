/**
 * Windows Module - Central Export
 */

const MainWindow = require('./MainWindow');
const QuickPickerWindow = require('./QuickPickerWindow');
const TrayManager = require('./TrayManager');
const NotificationWindow = require('./NotificationWindow');

module.exports = {
  ...MainWindow,
  ...QuickPickerWindow,
  ...TrayManager,
  ...NotificationWindow
};
