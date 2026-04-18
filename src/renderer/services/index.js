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
const MentionSourceRegistry = require('./MentionSourceRegistry');

// Register all built-in @-mention / Command Palette sources at module load.
// Safe to require even if no UI is mounted yet — registrations are lazy data-only.
require('./mention-sources').bootstrap();

module.exports = {
  MentionSourceRegistry,
  ProjectService,
  TerminalService,
  FivemService,
  DashboardService,
  SettingsService,
  TimeTrackingDashboard,
  GitTabService
};
