/**
 * Project Type Extension IPC Handlers
 *
 * The renderer's only route to `~/.claude-terminal/project-types/`. Two
 * handlers, both read-only as far as extension content goes: one lists what is
 * on disk, one makes sure the directory exists so the UI can reveal it.
 *
 * There is deliberately no `install`, no `download` and no `enable` handler.
 * Installing is "put a folder there yourself", and enabling is a settings edit
 * the renderer already owns — see `design/project-type-extensions.md` for why
 * neither gets an IPC shortcut.
 */

'use strict';

const { ipcMain } = require('electron');
const service = require('../services/ProjectTypeExtensionService');

function registerProjectTypeHandlers() {
  /**
   * 'project-types:list-extensions'
   *
   * Returns { dir, enabled, extensions, problems }. Resolves even when the
   * directory is missing or unreadable: the renderer calls this during boot, and
   * a rejected promise there is a broken startup path for a feature that is off
   * by default.
   */
  ipcMain.handle('project-types:list-extensions', async () => {
    try {
      return await service.listExtensions();
    } catch (err) {
      // listExtensions() is written not to throw; if it ever does, that is a bug
      // in the loader and still must not surface as a rejected IPC call.
      return {
        dir: null,
        enabled: false,
        extensions: [],
        problems: [{ id: null, reason: 'loader-failed', detail: err && err.message ? err.message : String(err) }],
      };
    }
  });

  /**
   * 'project-types:ensure-dir'
   * Creates the extensions directory if absent and returns its path.
   */
  ipcMain.handle('project-types:ensure-dir', async () => {
    try {
      return await service.ensureExtensionsDir();
    } catch (err) {
      return { dir: null, created: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

module.exports = { registerProjectTypeHandlers };
