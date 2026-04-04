import fs from 'fs';
import path from 'path';
import extractZip from 'extract-zip';
import { store, UserData } from '../store/store';
import { config } from '../config';

export class ProjectManager {

  async listProjects(userName: string): Promise<Array<{ name: string; displayName: string; createdAt: number | null; lastActivity: number | null }>> {
    const dirs = await store.listProjectDirs(userName);
    const user = await store.getUser(userName);
    return dirs.map(name => {
      const meta = user?.projects.find(p => p.name === name);
      return {
        name,
        displayName: meta?.displayName || name,
        createdAt: meta?.createdAt || null,
        lastActivity: meta?.lastActivity || null,
      };
    });
  }

  async createFromZip(userName: string, projectName: string, zipPath: string, displayName?: string): Promise<string> {
    this.validateProjectName(projectName);
    await this.checkProjectLimit(userName);

    const projectPath = await store.createProjectDir(userName, projectName);

    try {
      await extractZip(zipPath, { dir: projectPath });
    } catch (err: any) {
      await store.deleteProjectDir(userName, projectName);
      throw new Error(`Failed to extract zip: ${err.message}`);
    } finally {
      // Clean up uploaded zip
      await fs.promises.unlink(zipPath).catch(() => {});
    }

    // Verify no files escaped the project directory (path traversal protection)
    const extractedFiles = await this._walkDirFlat(projectPath);
    for (const f of extractedFiles) {
      const resolved = path.resolve(projectPath, f);
      if (!resolved.startsWith(projectPath)) {
        await store.deleteProjectDir(userName, projectName);
        throw new Error('Zip contains files with path traversal');
      }
    }

    // Update user.json
    const user = await store.getUser(userName);
    if (user) {
      const existing = user.projects.findIndex(p => p.name === projectName);
      const entry = { name: projectName, displayName: displayName || projectName, createdAt: Date.now(), lastActivity: null };
      if (existing >= 0) {
        user.projects[existing] = entry;
      } else {
        user.projects.push(entry);
      }
      await store.saveUser(userName, user);
    }

    return projectPath;
  }

  private async _walkDirFlat(dir: string, base: string = ''): Promise<string[]> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...await this._walkDirFlat(path.join(dir, entry.name), rel));
      } else {
        results.push(rel);
      }
    }
    return results;
  }

  // For downloads: exclude large/generated directories but keep .git
  private static EXCLUDE_DIRS_DOWNLOAD = new Set([
    'node_modules', 'build', 'dist', '.next', '__pycache__',
    '.venv', 'venv', '.cache', 'coverage', '.tsbuildinfo', '.ct-cloud',
    '.turbo', '.parcel-cache', '.svelte-kit', '.nuxt', '.output',
  ]);

  async deleteProject(userName: string, projectName: string): Promise<void> {
    await store.deleteProjectDir(userName, projectName);
    const user = await store.getUser(userName);
    if (user) {
      user.projects = user.projects.filter(p => p.name !== projectName);
      await store.saveUser(userName, user);
    }
  }

  async renameProject(userName: string, oldName: string, newName: string): Promise<void> {
    this.validateProjectName(newName);
    const oldPath = store.getProjectPath(userName, oldName);
    const newPath = store.getProjectPath(userName, newName);

    const oldExists = await this.projectExists(userName, oldName);
    if (!oldExists) throw new Error(`Project "${oldName}" does not exist`);

    const newExists = await this.projectExists(userName, newName);
    if (newExists) throw new Error(`Project "${newName}" already exists`);

    await fs.promises.rename(oldPath, newPath);

    const user = await store.getUser(userName);
    if (user) {
      const project = user.projects.find(p => p.name === oldName);
      if (project) project.name = newName;
      await store.saveUser(userName, user);
    }
  }

  async updateDisplayName(userName: string, projectName: string, displayName: string): Promise<void> {
    const user = await store.getUser(userName);
    if (!user) return;
    const project = user.projects.find(p => p.name === projectName);
    if (project) {
      project.displayName = displayName;
      await store.saveUser(userName, user);
    }
  }

  async projectExists(userName: string, projectName: string): Promise<boolean> {
    const projectPath = store.getProjectPath(userName, projectName);
    try {
      await fs.promises.access(projectPath);
      return true;
    } catch {
      return false;
    }
  }

  async touchProject(userName: string, projectName: string): Promise<void> {
    const user = await store.getUser(userName);
    if (!user) return;
    const project = user.projects.find(p => p.name === projectName);
    if (project) {
      project.lastActivity = Date.now();
      await store.saveUser(userName, user);
    }
  }

  /**
   * Stream the full project as a zip archive (excluding build/vendor dirs).
   */
  async downloadProjectZip(userName: string, projectName: string): Promise<NodeJS.ReadableStream> {
    const projectPath = store.getProjectPath(userName, projectName);
    const exists = await this.projectExists(userName, projectName);
    if (!exists) throw new Error(`Project "${projectName}" does not exist`);

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 6 } });

    await this._archiveDir(archive, projectPath, projectPath);
    archive.finalize();
    return archive;
  }

  private async _archiveDir(archive: any, baseDir: string, currentDir: string): Promise<void> {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (ProjectManager.EXCLUDE_DIRS_DOWNLOAD.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        await this._archiveDir(archive, baseDir, fullPath);
      } else {
        archive.file(fullPath, { name: relPath });
      }
    }
  }

  validateProjectName(name: string): void {
    if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
      throw new Error('Project name must be alphanumeric (a-z, 0-9, _, ., -)');
    }
    if (name.startsWith('.') || name.includes('..')) {
      throw new Error('Project name cannot start with dot or contain ".."');
    }
  }

  async checkProjectLimit(userName: string): Promise<void> {
    const dirs = await store.listProjectDirs(userName);
    if (dirs.length >= config.maxProjectsPerUser) {
      throw new Error(`Project limit reached (${config.maxProjectsPerUser})`);
    }
  }
}

export const projectManager = new ProjectManager();
