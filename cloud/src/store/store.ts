import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';

export interface UserProject {
  name: string;
  displayName?: string;
  createdAt: number;
  lastActivity: number | null;
}

export interface UserSession {
  id: string;
  projectName: string;
  status: 'idle' | 'running' | 'error';
  model: string;
  createdAt: number;
  lastActivity: number;
}

export interface UserData {
  id: string;
  name: string;
  apiKey?: string;       // Legacy plaintext (migrated to apiKeyHash on first auth)
  apiKeyHash: string;    // SHA256 of the API key
  createdAt: number;
  gitName?: string;
  gitEmail?: string;
  projects: UserProject[];
  sessions: UserSession[];
}

export interface ServerData {
  roomSecret: string;
  createdAt: number;
}

async function writeAtomic(filePath: string, data: string): Promise<void> {
  const tmpPath = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
  await fs.promises.writeFile(tmpPath, data, 'utf-8');
  await fs.promises.rename(tmpPath, filePath);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

class Store {
  private serverJsonPath(): string {
    return path.join(config.dataDir, 'server.json');
  }

  private userDir(name: string): string {
    return path.join(config.usersDir, name);
  }

  private userJsonPath(name: string): string {
    return path.join(this.userDir(name), 'user.json');
  }

  private userProjectsDir(name: string): string {
    return path.join(this.userDir(name), 'projects');
  }

  userHomePath(name: string): string {
    return path.join(this.userDir(name), 'home');
  }

  async ensureUserHome(name: string): Promise<void> {
    const home = this.userHomePath(name);
    await fs.promises.mkdir(path.join(home, '.claude'), { recursive: true });
  }

  async ensureDataDirs(): Promise<void> {
    await fs.promises.mkdir(config.dataDir, { recursive: true });
    await fs.promises.mkdir(config.usersDir, { recursive: true });
    await this.migrateGlobalCredentials();
  }

  /** Migrate legacy global credentials to the first user's home directory */
  private async migrateGlobalCredentials(): Promise<void> {
    const globalCreds = path.join(config.dataDir, 'claude', '.credentials.json');
    const globalGitconfig = path.join(config.dataDir, 'gitdata', '.gitconfig');
    const globalGitcreds = path.join(config.dataDir, 'gitdata', '.git-credentials');

    try {
      await fs.promises.access(globalCreds);
    } catch {
      return; // No legacy credentials, nothing to migrate
    }

    const users = await this.listUsers();
    if (users.length !== 1) return; // Only auto-migrate for single-user setups

    const userName = users[0];
    const home = this.userHomePath(userName);
    const userClaudeDir = path.join(home, '.claude');
    const userCreds = path.join(userClaudeDir, '.credentials.json');

    try {
      await fs.promises.access(userCreds);
      return; // User already has credentials, skip
    } catch {
      // Proceed with migration
    }

    await fs.promises.mkdir(userClaudeDir, { recursive: true });

    // Copy credentials
    try {
      await fs.promises.copyFile(globalCreds, userCreds);
      console.log(`[Migration] Copied Claude credentials to user "${userName}"`);
    } catch { /* ignore */ }

    // Copy gitconfig
    try {
      await fs.promises.access(globalGitconfig);
      await fs.promises.copyFile(globalGitconfig, path.join(home, '.gitconfig'));
      console.log(`[Migration] Copied .gitconfig to user "${userName}"`);
    } catch { /* ignore */ }

    // Copy git-credentials
    try {
      await fs.promises.access(globalGitcreds);
      await fs.promises.copyFile(globalGitcreds, path.join(home, '.git-credentials'));
      console.log(`[Migration] Copied .git-credentials to user "${userName}"`);
    } catch { /* ignore */ }
  }

  // ── Server ──

  async getServerData(): Promise<ServerData> {
    const data = await readJson<ServerData>(this.serverJsonPath());
    if (data) return data;
    const newData: ServerData = {
      roomSecret: crypto.randomBytes(32).toString('hex'),
      createdAt: Date.now(),
    };
    await this.ensureDataDirs();
    await writeAtomic(this.serverJsonPath(), JSON.stringify(newData, null, 2));
    return newData;
  }

  // ── Users ──

  async listUsers(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(config.usersDir, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [];
    }
  }

  async getUser(name: string): Promise<UserData | null> {
    return readJson<UserData>(this.userJsonPath(name));
  }

  getUserSync(name: string): UserData | null {
    try {
      const raw = fs.readFileSync(this.userJsonPath(name), 'utf-8');
      return JSON.parse(raw) as UserData;
    } catch {
      return null;
    }
  }

  async createUser(name: string, apiKey: string): Promise<UserData> {
    const userDir = this.userDir(name);
    await fs.promises.mkdir(userDir, { recursive: true });
    await fs.promises.mkdir(this.userProjectsDir(name), { recursive: true });
    await this.ensureUserHome(name);

    const userData: UserData = {
      id: crypto.randomUUID(),
      name,
      apiKeyHash: crypto.createHash('sha256').update(apiKey).digest('hex'),
      createdAt: Date.now(),
      projects: [],
      sessions: [],
    };
    await writeAtomic(this.userJsonPath(name), JSON.stringify(userData, null, 2));
    return userData;
  }

  async saveUser(name: string, data: UserData): Promise<void> {
    await writeAtomic(this.userJsonPath(name), JSON.stringify(data, null, 2));
  }

  async deleteUser(name: string): Promise<void> {
    const userDir = this.userDir(name);
    await fs.promises.rm(userDir, { recursive: true, force: true });
  }

  async userExists(name: string): Promise<boolean> {
    try {
      await fs.promises.access(this.userJsonPath(name));
      return true;
    } catch {
      return false;
    }
  }

  // ── Projects ──

  getProjectPath(userName: string, projectName: string): string {
    return path.join(this.userProjectsDir(userName), projectName);
  }

  async listProjectDirs(userName: string): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.userProjectsDir(userName), { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [];
    }
  }

  async createProjectDir(userName: string, projectName: string): Promise<string> {
    const projectPath = this.getProjectPath(userName, projectName);
    await fs.promises.mkdir(projectPath, { recursive: true });
    return projectPath;
  }

  async deleteProjectDir(userName: string, projectName: string): Promise<void> {
    const projectPath = this.getProjectPath(userName, projectName);
    await fs.promises.rm(projectPath, { recursive: true, force: true });
  }
}

export const store = new Store();
