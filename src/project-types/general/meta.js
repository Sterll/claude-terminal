/**
 * general — identity only.
 *
 * Split out of index.js so the registry can list this type (wizard card,
 * sidebar icon, category) without loading its renderer half. index.js and
 * everything it reaches is the behaviour, and it is import()ed on demand —
 * see the header of ../registry.js.
 *
 * Nothing heavy belongs here: this file is in the startup bundle for every
 * user, including the ones who will never own a standalone project.
 */

module.exports = {
  id: 'standalone',
  nameKey: 'newProject.types.standalone',
  descKey: 'newProject.types.standaloneDesc',
  category: 'general',
  icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>',
};
