/**
 * Renderer Services - Central Export
 */

const ProjectService = require('./ProjectService');
const TerminalService = require('./TerminalService');
const FivemService = require('./FivemService');
const DashboardService = require('./DashboardService');
const SettingsService = require('./SettingsService');
const TimeTrackingDashboard = require('./TimeTrackingDashboard');
const GitTabService = require('./GitTabService');

module.exports = {
  ProjectService,
  TerminalService,
  FivemService,
  DashboardService,
  SettingsService,
  TimeTrackingDashboard,
  GitTabService
};
