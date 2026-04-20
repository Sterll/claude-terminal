/**
 * Electron Builder Configuration
 * Utilise les variables d'environnement pour les données sensibles
 *
 * asarUnpack: the list of packages that must live outside the asar archive is
 * computed at build time from package.json deps (see scripts/resolve-unpack-deps.js).
 * The MCP server runs as an external `node` process and cannot read asar, so every
 * runtime-required module in its dependency tree must be unpacked. Auto-resolving
 * avoids the recurring breakage where a new transitive dep would silently be left
 * inside asar (e.g. the `is-property` incident).
 */

const { resolveUnpackGlobs } = require('./scripts/resolve-unpack-deps');

const UNPACK_ROOTS = [
  // Agent SDK (spawned as child process)
  '@anthropic-ai/claude-agent-sdk',
  // Native modules (require .node binaries)
  'node-pty',
  'keytar',
  'better-sqlite3',
  'bindings',
  // DB drivers used by the MCP server
  'mysql2',
  'pg',
  'mongodb',
];

module.exports = {
  appId: "com.yanis.claude-terminal",
  productName: "Claude Terminal",
  directories: {
    output: "build"
  },
  files: [
    "main.js",
    "index.html",
    "quick-picker.html",
    "setup-wizard.html",
    "notification.html",
    "styles/**/*",
    "dist/renderer.bundle.js",
    "dist/renderer.bundle.js.map",
    "src/main/**/*",
    "src/shared/**/*",
    "src/project-types/**/*",
    "assets/**/*",
    "resources/bundled-skills/**/*",
    "package.json"
  ],
  asarUnpack: resolveUnpackGlobs(UNPACK_ROOTS),
  extraResources: [
    {
      from: "resources/hooks",
      to: "hooks",
      filter: ["**/*"]
    },
    {
      from: "resources/scripts",
      to: "scripts",
      filter: ["**/*"]
    },
    {
      from: "remote-ui",
      to: "remote-ui",
      filter: ["**/*"]
    },
    {
      from: "resources/mcp-servers",
      to: "mcp-servers",
      filter: ["**/*"]
    },
    {
      from: "src/main/workflow-nodes",
      to: "mcp-servers/workflow-nodes",
      filter: ["**/*"]
    }
  ],
  win: {
    target: [
      {
        target: "nsis",
        arch: ["x64"]
      }
    ],
    icon: "assets/icon.ico"
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: false, // false prevents keepShortcuts=false — preserves taskbar pin across updates
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    differentialPackage: true,
    license: "LICENSE",
    installerSidebar: "build-assets/installer-sidebar.bmp",
    uninstallerSidebar: "build-assets/uninstaller-sidebar.bmp",
    installerHeader: "build-assets/installer-header.bmp",
    include: "build-assets/installer-custom.nsh"
  },
  mac: {
    target: "dmg",
    icon: "assets/icon.png",
    category: "public.app-category.developer-tools",
    darkModeSupport: true
  },
  dmg: {
    // Disable background/window customization to avoid hdiutil "Resource busy" on CI
    background: null,
    window: { width: 540, height: 380 },
    writeUpdateInfo: true
  },
  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] }
    ],
    icon: "assets/icon.png",
    category: "Development",
    synopsis: "Terminal for Claude Code projects",
    desktop: {
      Name: "Claude Terminal",
      Comment: "Terminal for Claude Code projects",
      Terminal: "false"
    }
  },
  publish: {
    provider: "github",
    owner: "Sterll",
    repo: "claude-terminal"
  }
};
