import fs from 'fs';
import path from 'path';
import extractZip from 'extract-zip';
import { store, validateName } from '../store/store';
import { withKeyLock } from '../store/locks';
import { execFile } from 'child_process';
import { promisify } from 'util';
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
    try {
      return await this.createProject(userName, projectName, displayName, async temporary => {
        let bytes = 0;
        let entries = 0;
        await extractZip(zipPath, { dir: temporary, onEntry: entry => {
          const name = entry.fileName.replace(/\\/g, '/');
          const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
          bytes += entry.uncompressedSize;
          if (++entries > 10000 || bytes > config.maxExpandedBytes) throw new Error('Archive exceeds extraction limits');
          if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..') || name.includes('\0')) throw new Error('Invalid archive path');
          if (kind && kind !== 0x8000 && kind !== 0x4000) throw new Error('Archive links and special files are not supported');
        } });
      });
    } finally { await fs.promises.unlink(zipPath).catch(() => {}); }
  }

  async createFromClone(userName: string, name: string, cloneUrl: string, displayName?: string): Promise<string> {
    if (typeof cloneUrl !== 'string' || !/^https:\/\//i.test(cloneUrl)) throw new Error('Only HTTPS clone URLs are allowed');
    return this.createProject(userName, name, displayName, async temporary => {
      await promisify(execFile)('git', ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', 'clone', '--depth=1', '--', cloneUrl, temporary], { timeout: 5 * 60 * 1000 });
    });
  }

  private async createProject(userName: string, name: string, displayName: string | undefined, populate: (dir: string) => Promise<void>): Promise<string> {
    const destination = store.getProjectPath(userName, name);
    return withKeyLock(`projects:${userName}`, async () => {
      await this.checkProjectLimit(userName);
      if (await this.projectExists(userName, name)) throw Object.assign(new Error('Project already exists'), { status: 409 });
      const temporary = await fs.promises.mkdtemp(path.join(path.dirname(destination), '.import-'));
      try {
        await populate(temporary);
        if (await this.projectExists(userName, name)) throw Object.assign(new Error('Project already exists'), { status: 409 });
        await fs.promises.rename(temporary, destination);
      } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
      await store.updateUser(userName, user => {
        user.projects.push({ name, displayName: displayName || name, createdAt: Date.now(), lastActivity: null });
      });
      return destination;
    });
  }

  // For downloads: exclude large/generated directories but keep .git
  private static EXCLUDE_DIRS_DOWNLOAD = new Set([
    'node_modules', 'build', 'dist', '.next', '__pycache__',
    '.venv', 'venv', '.cache', 'coverage', '.tsbuildinfo', '.ct-cloud',
    '.turbo', '.parcel-cache', '.svelte-kit', '.nuxt', '.output',
  ]);

  async deleteProject(userName: string, projectName: string): Promise<void> {
    await withKeyLock(`projects:${userName}`, async () => {
      await store.deleteProjectDir(userName, projectName);
      await store.updateUser(userName, user => { user.projects = user.projects.filter(p => p.name !== projectName); });
    });
  }

  async renameProject(userName: string, oldName: string, newName: string): Promise<void> {
    await withKeyLock(`projects:${userName}`, async () => {
      this.validateProjectName(newName);
      const oldPath = store.getProjectPath(userName, oldName);
      const newPath = store.getProjectPath(userName, newName);

      const oldExists = await this.projectExists(userName, oldName);
      if (!oldExists) throw new Error(`Project "${oldName}" does not exist`);

      const newExists = await this.projectExists(userName, newName);
      if (newExists) throw new Error(`Project "${newName}" already exists`);

      await fs.promises.rename(oldPath, newPath);

      await store.updateUser(userName, user => {
        const project = user.projects.find(p => p.name === oldName);
        if (project) project.name = newName;
    });
    });
  }

  async updateDisplayName(userName: string, projectName: string, displayName: string): Promise<void> {
    store.getProjectPath(userName, projectName);
    await store.updateUser(userName, user => {
    const project = user.projects.find(p => p.name === projectName);
    if (project) {
      project.displayName = displayName;
    }
    });
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
    store.getProjectPath(userName, projectName);
    await store.updateUser(userName, user => {
    const project = user.projects.find(p => p.name === projectName);
    if (project) {
      project.lastActivity = Date.now();
    }
    });
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
      } else if (entry.isFile()) {
        archive.file(fullPath, { name: relPath });
      }
    }
  }

  validateProjectName(name: string): void {
    validateName(name);
  }

  async checkProjectLimit(userName: string): Promise<void> {
    const dirs = await store.listProjectDirs(userName);
    if (dirs.length >= config.maxProjectsPerUser) {
      throw new Error(`Project limit reached (${config.maxProjectsPerUser})`);
    }
  }
}

export const projectManager = new ProjectManager();
