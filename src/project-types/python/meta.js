/**
 * python — identity only.
 *
 * Split out of index.js so the registry can list this type (wizard card,
 * sidebar icon, category) without loading its renderer half. index.js and
 * everything it reaches is the behaviour, and it is import()ed on demand —
 * see the header of ../registry.js.
 *
 * Nothing heavy belongs here: this file is in the startup bundle for every
 * user, including the ones who will never own a python project.
 */

module.exports = {
  id: 'python',
  nameKey: 'newProject.types.python',
  descKey: 'newProject.types.pythonDesc',
  category: 'general',
  icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.585 11.692h4.328s2.432.039 2.432-2.35V5.391S16.714 3 11.936 3C7.362 3 7.647 4.986 7.647 4.986l.006 2.055h4.363v.617H5.92S3 7.28 3 11.874s2.569 4.426 2.569 4.426h1.533v-2.13s-.083-2.569 2.527-2.569l.004.004h-.048v.087zm-.272-4.41a.829.829 0 110-1.658.829.829 0 010 1.658zM14.415 12.308h-4.328s-2.432-.039-2.432 2.35v3.951S7.286 21 12.064 21c4.574 0 4.289-1.986 4.289-1.986l-.006-2.055h-4.363v-.617h6.096S21 16.72 21 12.126s-2.569-4.426-2.569-4.426h-1.533v2.13s.083 2.569-2.527 2.569l-.004-.004h.048v-.087zm.272 4.41a.829.829 0 110 1.658.829.829 0 010-1.658z"/></svg>',
};
