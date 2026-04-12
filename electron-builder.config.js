/**
 * Electron Builder Configuration
 * Utilise les variables d'environnement pour les données sensibles
 */

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
  asarUnpack: [
    // Agent SDK (spawned as child process)
    "node_modules/@anthropic-ai/claude-agent-sdk/**/*",
    // Native modules (require .node binaries)
    "node_modules/node-pty/**/*",
    "node_modules/keytar/**/*",
    "node_modules/better-sqlite3/**/*",
    "node_modules/bindings/**/*",
    // mysql2 + all transitive deps (used by MCP server — external node process can't read asar)
    "node_modules/mysql2/**/*",
    "node_modules/aws-ssl-profiles/**/*",
    "node_modules/denque/**/*",
    "node_modules/generate-function/**/*",
    "node_modules/iconv-lite/**/*",
    "node_modules/long/**/*",
    "node_modules/lru.min/**/*",
    "node_modules/named-placeholders/**/*",
    "node_modules/safer-buffer/**/*",
    "node_modules/sql-escaper/**/*",
    // pg + all transitive deps
    "node_modules/pg/**/*",
    "node_modules/pg-cloudflare/**/*",
    "node_modules/pg-connection-string/**/*",
    "node_modules/pg-int8/**/*",
    "node_modules/pg-pool/**/*",
    "node_modules/pg-protocol/**/*",
    "node_modules/pg-types/**/*",
    "node_modules/postgres-array/**/*",
    "node_modules/postgres-bytea/**/*",
    "node_modules/postgres-date/**/*",
    "node_modules/postgres-interval/**/*",
    "node_modules/pgpass/**/*",
    "node_modules/split2/**/*",
    // mongodb + all transitive deps
    "node_modules/mongodb/**/*",
    "node_modules/@mongodb-js/saslprep/**/*",
    "node_modules/sparse-bitfield/**/*",
    "node_modules/memory-pager/**/*",
    "node_modules/bson/**/*",
    "node_modules/mongodb-connection-string-url/**/*",
    "node_modules/@types/whatwg-url/**/*",
    "node_modules/@types/webidl-conversions/**/*",
    "node_modules/whatwg-url/**/*",
    "node_modules/tr46/**/*",
    "node_modules/webidl-conversions/**/*",
    "node_modules/punycode/**/*"
  ],
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
