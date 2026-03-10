/**
 * Format Duration Utility
 * Shared duration formatting for main process
 */

/**
 * Format milliseconds into a human-readable duration string (e.g. "2h 15m")
 * @param {number} ms - Duration in milliseconds
 * @returns {string}
 */
function formatDuration(ms) {
  if (!ms || ms < 0) ms = 0;
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

module.exports = { formatDuration };
