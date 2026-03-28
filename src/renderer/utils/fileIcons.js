/**
 * File Icons - SVG icons by file extension
 */

const FOLDER_ICON_CLOSED = `<svg viewBox="0 0 24 24" fill="currentColor" class="fe-icon fe-icon-folder"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;

const FOLDER_ICON_OPEN = `<svg viewBox="0 0 24 24" fill="currentColor" class="fe-icon fe-icon-folder-open"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>`;

const CHEVRON_ICON = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" class="fe-chevron"><path d="M4.5 2.5l3.5 3.5-3.5 3.5"/></svg>`;

const DEFAULT_FILE_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" class="fe-icon"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/></svg>`;

const IMAGE_ICON = `<svg viewBox="0 0 24 24" fill="#4caf50" class="fe-icon"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`;

const ICON_MAP = {
  // JavaScript / TypeScript
  js: `<svg viewBox="0 0 24 24" fill="#f7df1e" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="10" font-weight="bold" fill="#000">JS</text></svg>`,
  mjs: `<svg viewBox="0 0 24 24" fill="#f7df1e" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="10" font-weight="bold" fill="#000">JS</text></svg>`,
  ts: `<svg viewBox="0 0 24 24" fill="#3178c6" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="10" font-weight="bold" fill="#fff">TS</text></svg>`,
  tsx: `<svg viewBox="0 0 24 24" fill="#3178c6" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="9" font-weight="bold" fill="#fff">TSX</text></svg>`,
  jsx: `<svg viewBox="0 0 24 24" fill="#61dafb" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="9" font-weight="bold" fill="#000">JSX</text></svg>`,

  // Web
  html: `<svg viewBox="0 0 24 24" fill="#e44d26" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="7" font-weight="bold" fill="#fff">HTML</text></svg>`,
  css: `<svg viewBox="0 0 24 24" fill="#264de4" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">CSS</text></svg>`,
  scss: `<svg viewBox="0 0 24 24" fill="#cd6799" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="7" font-weight="bold" fill="#fff">SCSS</text></svg>`,
  less: `<svg viewBox="0 0 24 24" fill="#1d365d" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="7" font-weight="bold" fill="#fff">LESS</text></svg>`,
  svg: `<svg viewBox="0 0 24 24" fill="#ffb13b" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#000">SVG</text></svg>`,

  // Data / Config
  json: `<svg viewBox="0 0 24 24" fill="#6d8086" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="7" font-weight="bold" fill="#fff">JSON</text></svg>`,
  yaml: `<svg viewBox="0 0 24 24" fill="#cb171e" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="7" font-weight="bold" fill="#fff">YAML</text></svg>`,
  yml: `<svg viewBox="0 0 24 24" fill="#cb171e" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">YML</text></svg>`,
  xml: `<svg viewBox="0 0 24 24" fill="#e37933" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">XML</text></svg>`,
  toml: `<svg viewBox="0 0 24 24" fill="#9c4121" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="7" font-weight="bold" fill="#fff">TOML</text></svg>`,
  ini: `<svg viewBox="0 0 24 24" fill="#6d8086" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="9" font-weight="bold" fill="#fff">INI</text></svg>`,
  env: `<svg viewBox="0 0 24 24" fill="#ecd53f" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#000">ENV</text></svg>`,

  // Languages
  py: `<svg viewBox="0 0 24 24" fill="#3776ab" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="9" font-weight="bold" fill="#ffd43b">PY</text></svg>`,
  lua: `<svg viewBox="0 0 24 24" fill="#000080" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">LUA</text></svg>`,
  go: `<svg viewBox="0 0 24 24" fill="#00add8" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="9" font-weight="bold" fill="#fff">GO</text></svg>`,
  rs: `<svg viewBox="0 0 24 24" fill="#dea584" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="9" font-weight="bold" fill="#000">RS</text></svg>`,
  java: `<svg viewBox="0 0 24 24" fill="#b07219" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="7" font-weight="bold" fill="#fff">JAVA</text></svg>`,
  cs: `<svg viewBox="0 0 24 24" fill="#178600" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="9" font-weight="bold" fill="#fff">C#</text></svg>`,
  cpp: `<svg viewBox="0 0 24 24" fill="#f34b7d" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">C++</text></svg>`,
  c: `<svg viewBox="0 0 24 24" fill="#555555" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="10" font-weight="bold" fill="#fff">C</text></svg>`,
  php: `<svg viewBox="0 0 24 24" fill="#4f5d95" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">PHP</text></svg>`,
  rb: `<svg viewBox="0 0 24 24" fill="#cc342d" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="9" font-weight="bold" fill="#fff">RB</text></svg>`,
  sh: `<svg viewBox="0 0 24 24" fill="#4eaa25" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="9" font-weight="bold" fill="#fff">SH</text></svg>`,
  bat: `<svg viewBox="0 0 24 24" fill="#4eaa25" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">BAT</text></svg>`,
  ps1: `<svg viewBox="0 0 24 24" fill="#012456" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">PS1</text></svg>`,
  sql: `<svg viewBox="0 0 24 24" fill="#e38c00" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">SQL</text></svg>`,

  // Docs
  md: `<svg viewBox="0 0 24 24" fill="#083fa1" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">MD</text></svg>`,
  txt: `<svg viewBox="0 0 24 24" fill="currentColor" class="fe-icon"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`,
  pdf: `<svg viewBox="0 0 24 24" fill="#e53935" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">PDF</text></svg>`,

  // 3D Models
  obj: `<svg viewBox="0 0 24 24" fill="#7b1fa2" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">OBJ</text></svg>`,
  stl: `<svg viewBox="0 0 24 24" fill="#00897b" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">STL</text></svg>`,
  gltf: `<svg viewBox="0 0 24 24" fill="#43a047" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="7" font-weight="bold" fill="#fff">GLTF</text></svg>`,
  glb: `<svg viewBox="0 0 24 24" fill="#43a047" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">GLB</text></svg>`,

  // Images (deduplicated)
  png: IMAGE_ICON,
  jpg: IMAGE_ICON,
  jpeg: IMAGE_ICON,
  gif: IMAGE_ICON,
  webp: IMAGE_ICON,
  ico: IMAGE_ICON,

  // Package
  'package.json': `<svg viewBox="0 0 24 24" fill="#cb3837" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="7" font-weight="bold" fill="#fff">NPM</text></svg>`,
};

// Special filenames that get specific icons
const FILENAME_MAP = {
  'package.json': ICON_MAP['package.json'],
  'package-lock.json': ICON_MAP['package.json'],
  '.gitignore': `<svg viewBox="0 0 24 24" fill="#f05032" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="8" font-weight="bold" fill="#fff">GIT</text></svg>`,
  'Dockerfile': `<svg viewBox="0 0 24 24" fill="#2496ed" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="5.5" font-weight="bold" fill="#fff">DOCK</text></svg>`,
  'LICENSE': `<svg viewBox="0 0 24 24" fill="#d4aa00" class="fe-icon"><rect width="24" height="24" rx="2"/><text x="12" y="17" text-anchor="middle" font-size="7" font-weight="bold" fill="#fff">LIC</text></svg>`,
  '.env': ICON_MAP.env,
  '.env.local': ICON_MAP.env,
  '.env.development': ICON_MAP.env,
  '.env.production': ICON_MAP.env,
};

/**
 * Get the icon SVG for a file
 * @param {string} filename - The file name
 * @param {boolean} isDirectory - Is it a directory
 * @param {boolean} isExpanded - Is the directory expanded
 * @returns {string} SVG HTML string
 */
function getFileIcon(filename, isDirectory = false, isExpanded = false) {
  if (isDirectory) {
    return isExpanded ? FOLDER_ICON_OPEN : FOLDER_ICON_CLOSED;
  }

  if (FILENAME_MAP[filename]) {
    return FILENAME_MAP[filename];
  }

  const dotIdx = filename.lastIndexOf('.');
  const ext = dotIdx !== -1 ? filename.substring(dotIdx + 1).toLowerCase() : '';
  return ICON_MAP[ext] || DEFAULT_FILE_ICON;
}

module.exports = {
  getFileIcon,
  CHEVRON_ICON
};
