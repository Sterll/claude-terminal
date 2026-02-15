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
    "styles.css",
    "dist/renderer.bundle.js",
    "dist/renderer.bundle.js.map",
    "src/main/**/*",
    "src/project-types/**/*",
    "assets/**/*",
    "resources/bundled-skills/**/*",
    "package.json"
  ],
  asarUnpack: [
    "node_modules/@anthropic-ai/claude-agent-sdk/**/*",
    "node_modules/node-pty/**/*",
    "node_modules/keytar/**/*"
  ],
  extraResources: [
    {
      from: "resources/hooks",
      to: "hooks",
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
    allowToChangeInstallationDirectory: true,
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
    target: [
      { target: "dmg", arch: ["x64", "arm64"] }
    ],
    icon: "assets/icon.png",
    category: "public.app-category.developer-tools",
    darkModeSupport: true
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
    provider: "generic",
    url: process.env.UPDATE_SERVER_URL,
    useMultipleRangeRequest: false
  }
};
