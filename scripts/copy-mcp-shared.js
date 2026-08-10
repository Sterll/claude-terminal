'use strict';

/**
 * electron-builder `afterPack` hook.
 *
 * The external MCP server runs as a plain `node` process and cannot require
 * from inside app.asar, so it needs `src/shared` and `src/main/workflow-nodes`
 * available unpacked next to `resources/mcp-servers/`.
 *
 * These used to be `extraResources` entries, which was a trap: app-builder-lib
 * turns every `extraResources.from` that lives inside the project into an
 * EXCLUDE pattern for the app files copy (platformPackager.js -> excludePatterns
 * -> copyAppFiles). So `from: "src/shared"` silently removed `src/shared/**`
 * from app.asar even though it was listed in `files`, and the main process
 * crashed at startup on `require('../../shared/workflow-schema')` (issue #68).
 * The same applied to `src/main/workflow-nodes`, which had been missing from
 * app.asar since it was added to extraResources.
 *
 * Copying in `afterPack` runs after both the app copy and the extraResources
 * copy, so nothing is excluded and the sources stay in a single place.
 */

const fs = require('fs');
const path = require('path');

// from: repo-relative source, to: destination under <resources>/mcp-servers/
const MCP_SHARED_COPIES = [
  { from: path.join('src', 'shared'), to: 'shared' },
  { from: path.join('src', 'main', 'workflow-nodes'), to: 'workflow-nodes' },
];

// electron-builder exposes the per-platform resources dir on the packager
// (mac nests it inside the .app bundle); fall back to computing it ourselves if
// a future version renames the helper.
function getResourcesDir(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  if (typeof packager?.getResourcesDir === 'function') {
    return packager.getResourcesDir(appOutDir);
  }
  if (electronPlatformName === 'darwin') {
    return path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

module.exports = async function copyMcpShared(context) {
  const projectDir = path.resolve(__dirname, '..');
  const mcpServersDir = path.join(getResourcesDir(context), 'mcp-servers');

  for (const { from, to } of MCP_SHARED_COPIES) {
    const sourceDir = path.join(projectDir, from);
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`[copy-mcp-shared] missing source directory: ${sourceDir}`);
    }
    const destinationDir = path.join(mcpServersDir, to);
    fs.cpSync(sourceDir, destinationDir, { recursive: true });
    console.log(`  • copied ${from} -> mcp-servers/${to}`);
  }
};
