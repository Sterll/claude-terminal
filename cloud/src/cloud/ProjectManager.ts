import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import extractZip from 'extract-zip';
import { store, UserData } from '../store/store';
import { config } from '../config';

export class ProjectManager {

  async listProjects(userName: string): Promise<Array<{ name: string; createdAt: number | null; lastActivity: number | null }>> {
    const dirs = await store.listProjectDirs(userName);
    const user = await store.getUser(userName);
    return dirs.map(name => {
      const meta = user?.projects.find(p => p.name === name);
      return {
        name,
        createdAt: meta?.createdAt || null,
        lastActivity: meta?.lastActivity || null,
      };
    });
  }

  async createFromZip(userName: string, projectName: string, zipPath: string): Promise<string> {
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

    // Update user.json
    const user = await store.getUser(userName);
    if (user) {
      const existing = user.projects.findIndex(p => p.name === projectName);
      const entry = { name: projectName, createdAt: Date.now(), lastActivity: null };
      if (existing >= 0) {
        user.projects[existing] = entry;
      } else {
        user.projects.push(entry);
      }
      await store.saveUser(userName, user);
    }

    return projectPath;
  }

  async syncProject(userName: string, projectName: string, zipPath: string): Promise<void> {
    const projectPath = store.getProjectPath(userName, projectName);
    const exists = await this.projectExists(userName, projectName);
    if (!exists) throw new Error(`Project "${projectName}" does not exist`);

    // Clear existing files but keep .git if present
    const entries = await fs.promises.readdir(projectPath);
    for (const entry of entries) {
      if (entry === '.git') continue;
      await fs.promises.rm(path.join(projectPath, entry), { recursive: true, force: true });
    }

    try {
      await extractZip(zipPath, { dir: projectPath });
    } finally {
      await fs.promises.unlink(zipPath).catch(() => {});
    }

    // Update lastActivity
    await this.touchProject(userName, projectName);
  }

  /**
   * Incremental sync: apply only changed files from zip, handle .DELETED markers.
   * Unlike syncProject(), this does NOT clear existing files first.
   */
  async patchProject(userName: string, projectName: string, zipPath: string): Promise<{ applied: number; deleted: number }> {
    const projectPath = store.getProjectPath(userName, projectName);
    const exists = await this.projectExists(userName, projectName);
    if (!exists) throw new Error(`Project "${projectName}" does not exist`);

    // Extract to temp dir first
    const tempDir = path.join(require('os').tmpdir(), `ct-patch-${Date.now()}`);
    try {
      await extractZip(zipPath, { dir: tempDir });

      let applied = 0;
      let deleted = 0;

      // Walk extracted files and apply them
      const allFiles = await this._walkDir(tempDir);
      for (const relPath of allFiles) {
        if (relPath.endsWith('.DELETED')) {
          // Delete the original file from project
          const originalPath = path.join(projectPath, relPath.replace(/\.DELETED$/, ''));
          await fs.promises.unlink(originalPath).catch(() => {});
          deleted++;
        } else {
          // Copy/overwrite file into project
          const src = path.join(tempDir, relPath);
          const dest = path.join(projectPath, relPath);
          await fs.promises.mkdir(path.dirname(dest), { recursive: true });
          await fs.promises.copyFile(src, dest);
          applied++;
        }
      }

      await this.touchProject(userName, projectName);
      return { applied, deleted };
    } finally {
      await fs.promises.unlink(zipPath).catch(() => {});
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async _walkDir(dir: string, base: string = ''): Promise<string[]> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...await this._walkDir(path.join(dir, entry.name), rel));
      } else {
        results.push(rel);
      }
    }
    return results;
  }

  private static EXCLUDE_DIRS = new Set([
    'node_modules', '.git', 'build', 'dist', '.next', '__pycache__',
    '.venv', 'venv', '.cache', 'coverage', '.tsbuildinfo', '.ct-cloud',
    '.turbo', '.parcel-cache', '.svelte-kit', '.nuxt', '.output',
  ]);

  // For downloads: same exclusions but keep .git
  private static EXCLUDE_DIRS_DOWNLOAD = new Set([
    'node_modules', 'build', 'dist', '.next', '__pycache__',
    '.venv', 'venv', '.cache', 'coverage', '.tsbuildinfo', '.ct-cloud',
    '.turbo', '.parcel-cache', '.svelte-kit', '.nuxt', '.output',
  ]);

  /**
   * List all files in a cloud project with their sizes.
   * Used by client to compare local vs cloud.
   */
  async listProjectFiles(userName: string, projectName: string): Promise<Array<{ path: string; size: number }>> {
    const projectPath = store.getProjectPath(userName, projectName);
    const exists = await this.projectExists(userName, projectName);
    if (!exists) throw new Error(`Project "${projectName}" does not exist`);

    const results: Array<{ path: string; size: number }> = [];
    await this._walkDirWithStats(projectPath, projectPath, results, 0);
    return results;
  }

  private static readonly MAX_DEPTH = 30;

  private async _walkDirWithStats(baseDir: string, currentDir: string, results: Array<{ path: string; size: number }>, depth: number): Promise<void> {
    if (depth >= ProjectManager.MAX_DEPTH) return;
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (ProjectManager.EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await this._walkDirWithStats(baseDir, fullPath, results, depth + 1);
      } else {
        const stat = await fs.promises.stat(fullPath);
        const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        results.push({ path: rel, size: stat.size });
      }
    }
  }

  async deleteProject(userName: string, projectName: string): Promise<void> {
    await store.deleteProjectDir(userName, projectName);
    const user = await store.getUser(userName);
    if (user) {
      user.projects = user.projects.filter(p => p.name !== projectName);
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

  async getUnsyncedChanges(userName: string, projectName: string): Promise<Array<{
    sessionId: string;
    changedFiles: string[];
    completedAt: number;
  }>> {
    const projectPath = store.getProjectPath(userName, projectName);
    const changesDir = path.join(projectPath, '.ct-cloud');
    try {
      const files = await fs.promises.readdir(changesDir);
      const results: Array<{ sessionId: string; changedFiles: string[]; completedAt: number }> = [];
      for (const file of files) {
        if (!file.startsWith('changes-') || !file.endsWith('.json')) continue;
        const data = JSON.parse(await fs.promises.readFile(path.join(changesDir, file), 'utf-8'));
        if (!data.synced) results.push(data);
      }
      return results;
    } catch {
      return [];
    }
  }

  async downloadChangesZip(userName: string, projectName: string): Promise<NodeJS.ReadableStream> {
    const projectPath = store.getProjectPath(userName, projectName);
    const changes = await this.getUnsyncedChanges(userName, projectName);

    // Collect all unique changed files across unsynced sessions
    const allFiles = new Set<string>();
    for (const change of changes) {
      for (const f of change.changedFiles) allFiles.add(f);
    }

    if (allFiles.size === 0) throw new Error('No changes to download');

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 6 } });

    for (const relPath of allFiles) {
      const absPath = path.join(projectPath, relPath);
      try {
        await fs.promises.access(absPath);
        archive.file(absPath, { name: relPath });
      } catch {
        // File was deleted — include a marker
        archive.append('', { name: relPath + '.DELETED' });
      }
    }

    archive.finalize();
    return archive;
  }

  async acknowledgeChanges(userName: string, projectName: string): Promise<void> {
    const projectPath = store.getProjectPath(userName, projectName);
    const changesDir = path.join(projectPath, '.ct-cloud');
    try {
      const files = await fs.promises.readdir(changesDir);
      for (const file of files) {
        if (!file.startsWith('changes-') || !file.endsWith('.json')) continue;
        const filePath = path.join(changesDir, file);
        const data = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
        data.synced = true;
        await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf-8');
      }
    } catch {
      // No changes dir — nothing to ack
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

  /**
   * Compute SHA256 hash of a single file via streaming.
   */
  private _hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Hash specific files in a cloud project.
   * Returns only files that exist; missing files are omitted.
   */
  async hashProjectFiles(userName: string, projectName: string, filePaths: string[]): Promise<Array<{ path: string; hash: string }>> {
    const projectPath = store.getProjectPath(userName, projectName);
    const exists = await this.projectExists(userName, projectName);
    if (!exists) throw new Error(`Project "${projectName}" does not exist`);

    const BATCH = 20;
    const results: Array<{ path: string; hash: string }> = [];

    for (let i = 0; i < filePaths.length; i += BATCH) {
      const batch = filePaths.slice(i, i + BATCH);
      const promises = batch.map(async (relPath) => {
        try {
          // Prevent path traversal
          const absPath = path.resolve(projectPath, relPath);
          if (!absPath.startsWith(projectPath)) return null;
          const h = await this._hashFile(absPath);
          return { path: relPath, hash: h };
        } catch {
          return null;
        }
      });
      const batchResults = await Promise.all(promises);
      for (const r of batchResults) {
        if (r) results.push(r);
      }
    }

    return results;
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
