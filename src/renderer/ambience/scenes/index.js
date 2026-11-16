/**
 * Scene registry. Static requires on purpose: esbuild bundles what it can see,
 * and every scene is a few kilobytes of drawing code with no dependency.
 */
const SCENES = [
  require('./ocean'),
  require('./forest'),
  require('./autumn'),
  require('./meadow'),
  require('./rain'),
  require('./city'),
  require('./synthwave'),
  require('./aurora'),
  require('./snow'),
  require('./space'),
  require('./sakura'),
  require('./desert'),
  require('./underwater'),
  require('./gradient'),
  require('./bokeh'),
  require('./zen'),
  require('./campfire'),
  require('./neonrain'),
];

const byId = new Map(SCENES.map((s) => [s.id, s]));

function getScene(id) { return byId.get(id) || null; }
function listScenes() { return SCENES.map((s) => s.id); }

module.exports = { SCENES, getScene, listScenes };
