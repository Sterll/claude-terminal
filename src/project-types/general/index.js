/**
 * General (Standalone) Project Type
 * Minimal type - inherits all defaults from base-type.
 */

const { createType } = require('../base-type');

module.exports = createType({
  ...require('./meta')
});
