/**
 * machineId.js
 * Generates and persists a stable machine identifier for cloud project scoping.
 * Format: {hostname-sanitized}-{8 hex chars}
 * Example: pc-yanis-a1b2c3d4
 */

const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const { settingsFile, machineIdFile, ensureDataDir } = require('./paths');

const MAX_LEN = 32;

/**
 * Sanitize a string: lowercase, alphanumeric + dashes only, max MAX_LEN chars.
 */
function sanitizeName(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LEN - 9); // leave room for -xxxxxxxx suffix
}

/**
 * Generate a new machineId (not persisted).
 */
function generateMachineId() {
  const hostname = sanitizeName(os.hostname()) || 'pc';
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${hostname}-${suffix}`;
}

/**
 * Get the machineId for this installation.
 * Lives in its own main-owned file: a read-modify-write on settings.json from
 * here could race the renderer's atomic saves and wipe the user's settings.
 * @returns {string}
 */
function getMachineId() {
  try {
    const data = JSON.parse(fs.readFileSync(machineIdFile, 'utf8'));
    if (data && typeof data.machineId === 'string') {
      return data.machineId;
    }
  } catch (e) {
    // Fall through to the legacy location
  }

  // Legacy: machineId used to be stored in settings.json (read-only fallback,
  // migrated to its own file so existing installs keep their cloud scoping).
  try {
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (settings.machineId && typeof settings.machineId === 'string') {
        _persistMachineId(settings.machineId);
        return settings.machineId;
      }
    }
  } catch (e) {
    // Fall through to generate
  }

  const id = generateMachineId();
  _persistMachineId(id);
  return id;
}

function _persistMachineId(id) {
  try {
    ensureDataDir();
    fs.writeFileSync(machineIdFile, JSON.stringify({ machineId: id }, null, 2), 'utf8');
  } catch (e) {
    console.warn('[machineId] Failed to persist machineId:', e.message);
  }
}

module.exports = { getMachineId, generateMachineId, sanitizeName };
