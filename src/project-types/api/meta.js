/**
 * api — identity only.
 *
 * Split out of index.js so the registry can list this type (wizard card,
 * sidebar icon, category) without loading its renderer half. index.js and
 * everything it reaches is the behaviour, and it is import()ed on demand —
 * see the header of ../registry.js.
 *
 * Nothing heavy belongs here: this file is in the startup bundle for every
 * user, including the ones who will never own a api project.
 */

module.exports = {
  id: 'api',
  nameKey: 'newProject.types.api',
  descKey: 'newProject.types.apiDesc',
  category: 'general',
  icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 1h16a2 2 0 012 2v3a2 2 0 01-2 2H4a2 2 0 01-2-2V3a2 2 0 012-2zm0 8h16a2 2 0 012 2v3a2 2 0 01-2 2H4a2 2 0 01-2-2v-3a2 2 0 012-2zm0 8h16a2 2 0 012 2v3a2 2 0 01-2 2H4a2 2 0 01-2-2v-3a2 2 0 012-2zm1-13v1h2V4H5zm0 8v1h2v-1H5zm0 8v1h2v-1H5z"/></svg>',
};
