import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { authenticateApiKey } from '../auth/auth';
import { store } from '../store/store';
import { projectManager } from './ProjectManager';
import { sessionManager } from './SessionManager';
import { config } from '../config';

// Extend Request with user info
interface AuthRequest extends Request {
  userName?: string;
}

// Auth middleware
async function authMiddleware(req: AuthRequest, res: Response, next: Function): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  const userName = await authenticateApiKey(token);
  if (!userName) {
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }

  req.userName = userName;
  next();
}

// Multer for zip uploads
const upload = multer({
  dest: path.join(os.tmpdir(), 'ct-cloud-uploads'),
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only .zip files are accepted'));
    }
  }
});

// ── Rate limiter (per user, sliding window) ──
const RATE_WINDOW_MS = 60_000;
const _rates = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(key: string, limit: number): boolean {
  const now = Date.now();
  let entry = _rates.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    _rates.set(key, entry);
  }
  entry.count++;
  return entry.count > limit;
}

// Cleanup stale rate entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _rates) {
    if (now >= entry.resetAt) _rates.delete(key);
  }
}, 5 * 60_000).unref();

export function createCloudRouter(): Router {
  const router = Router();

  router.use(authMiddleware as any);

  // General rate limit (per user)
  router.use((req: AuthRequest, res: Response, next: Function) => {
    if (req.userName && isRateLimited(`api:${req.userName}`, config.rateLimitPerMinute)) {
      res.status(429).json({ error: `Rate limit exceeded (${config.rateLimitPerMinute} req/min)` });
      return;
    }
    next();
  });

  // ── User Profile ──

  router.get('/me', async (req: AuthRequest, res: Response) => {
    try {
      const user = await store.getUser(req.userName!);
      if (!user) { res.status(404).json({ error: 'User not found' }); return; }
      const credPath = path.join(store.userHomePath(req.userName!), '.claude', '.credentials.json');
      let claudeAuthed = false;
      try { fs.accessSync(credPath); claudeAuthed = true; } catch { /* not authed */ }
      res.json({
        name: user.name,
        gitName: user.gitName || null,
        gitEmail: user.gitEmail || null,
        claudeAuthed,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/me', async (req: AuthRequest, res: Response) => {
    try {
      const { gitName, gitEmail } = req.body;
      const user = await store.getUser(req.userName!);
      if (!user) { res.status(404).json({ error: 'User not found' }); return; }

      // Validate gitName/gitEmail to prevent gitconfig injection
      if (gitName !== undefined) {
        if (typeof gitName !== 'string' || gitName.length > 128 || /[\n\r\t\[\]\\]/.test(gitName)) {
          res.status(400).json({ error: 'Invalid git name (no newlines, brackets, or backslashes allowed)' });
          return;
        }
        user.gitName = gitName;
      }
      if (gitEmail !== undefined) {
        if (typeof gitEmail !== 'string' || gitEmail.length > 256 || /[\n\r\t\[\]\\]/.test(gitEmail)) {
          res.status(400).json({ error: 'Invalid git email (no newlines, brackets, or backslashes allowed)' });
          return;
        }
        user.gitEmail = gitEmail;
      }
      await store.saveUser(req.userName!, user);

      // Write .gitconfig file in user's home
      if (user.gitName && user.gitEmail) {
        await store.ensureUserHome(req.userName!);
        const gitconfigPath = path.join(store.userHomePath(req.userName!), '.gitconfig');
        const safeName = user.gitName.replace(/[^\x20-\x7E]/g, '');
        const safeEmail = user.gitEmail.replace(/[^\x20-\x7E]/g, '');
        const content = `[user]\n\tname = ${safeName}\n\temail = ${safeEmail}\n`;
        await fs.promises.writeFile(gitconfigPath, content, 'utf-8');
      }

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Projects ──

  router.get('/projects', async (req: AuthRequest, res: Response) => {
    try {
      const projects = await projectManager.listProjects(req.userName!);
      res.json({ projects });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Clone a GitHub repo into a project (faster than ZIP upload)
  router.post('/projects/clone', async (req: AuthRequest, res: Response) => {
    try {
      const { name, cloneUrl, displayName } = req.body;
      if (!name || !cloneUrl) {
        res.status(400).json({ error: 'Missing name or cloneUrl' });
        return;
      }

      // Restrict to HTTPS URLs only — reject file://, ssh://, git://, etc.
      if (!/^https?:\/\//i.test(cloneUrl)) {
        res.status(400).json({ error: 'Only HTTPS clone URLs are allowed' });
        return;
      }

      projectManager.validateProjectName(name);
      await projectManager.checkProjectLimit(req.userName!);

      const projectPath = await store.createProjectDir(req.userName!, name);
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);

      // Clone into a tmp dir then move contents so folder name = project name
      const tmpDest = projectPath + '__clone_tmp';
      try {
        await execFileAsync('git', ['clone', '--depth=1', cloneUrl, tmpDest], { timeout: 5 * 60 * 1000 });
        const entries = await fs.promises.readdir(tmpDest);
        for (const entry of entries) {
          await fs.promises.rename(path.join(tmpDest, entry), path.join(projectPath, entry));
        }
      } catch (err: any) {
        await store.deleteProjectDir(req.userName!, name);
        throw new Error(`Clone failed: ${err.message}`);
      } finally {
        await fs.promises.rm(tmpDest, { recursive: true, force: true }).catch(() => {});
      }

      // Register in user.json
      const user = await store.getUser(req.userName!);
      if (user) {
        const existing = user.projects.findIndex((p: any) => p.name === name);
        const entry = { name, displayName: displayName || name, createdAt: Date.now(), lastActivity: null };
        if (existing >= 0) user.projects[existing] = entry;
        else user.projects.push(entry);
        await store.saveUser(req.userName!, user);
      }

      res.status(201).json({ name, displayName: displayName || name, path: projectPath });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/projects', upload.single('zip'), async (req: AuthRequest, res: Response) => {
    try {
      const name = req.body?.name;
      const displayName = req.body?.displayName || name;
      if (!name) {
        // Clean up multer temp file if present before returning error
        if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
        res.status(400).json({ error: 'Missing project name' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'Missing zip file' });
        return;
      }

      const projectPath = await projectManager.createFromZip(req.userName!, name, req.file.path, displayName);
      res.status(201).json({ name, displayName, path: projectPath });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Download full project as zip ──

  router.get('/projects/:name/download', async (req: AuthRequest, res: Response) => {
    try {
      const name = req.params.name as string;
      const zipStream = await projectManager.downloadProjectZip(req.userName!, name);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}.zip"`);
      zipStream.pipe(res);
      (zipStream as any).on('error', (err: Error) => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  router.patch('/projects/:name', async (req: AuthRequest, res: Response) => {
    try {
      const name = req.params.name as string;
      const { newName, displayName } = req.body;

      // Update display name only (no folder rename)
      if (displayName && typeof displayName === 'string' && !newName) {
        await projectManager.updateDisplayName(req.userName!, name, displayName);
        res.json({ ok: true, displayName });
        return;
      }

      // Full rename (folder + metadata)
      if (!newName || typeof newName !== 'string') {
        res.status(400).json({ error: 'Missing newName or displayName' });
        return;
      }
      await projectManager.renameProject(req.userName!, name, newName);
      res.json({ ok: true, newName });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/projects/:name', async (req: AuthRequest, res: Response) => {
    try {
      const name = req.params.name as string;
      await projectManager.deleteProject(req.userName!, name);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Sessions ──

  if (!config.cloudEnabled) {
    router.all('/sessions*', (_req, res) => {
      res.status(503).json({ error: 'Cloud sessions are disabled (CLOUD_ENABLED=false)' });
    });
    return router;
  }

  router.get('/sessions', async (req: AuthRequest, res: Response) => {
    try {
      const sessions = sessionManager.listUserSessions(req.userName!);
      res.json({ sessions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/sessions', async (req: AuthRequest, res: Response) => {
    try {
      const { projectName, prompt, model, effort, resumeSessionId } = req.body;
      if (!projectName || !prompt) {
        res.status(400).json({ error: 'Missing projectName or prompt' });
        return;
      }

      console.log(`[API] POST /sessions user=${req.userName} project=${projectName} model=${model || 'default'}${resumeSessionId ? ` resume=${resumeSessionId}` : ''}`);
      const sessionId = await sessionManager.createSession(req.userName!, projectName, prompt, model, effort, resumeSessionId);
      console.log(`[API] Session created: ${sessionId}`);
      res.status(201).json({ sessionId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/sessions/history/:projectName', async (req: AuthRequest, res: Response) => {
    try {
      const projectName = req.params.projectName as string;
      const sessions = await sessionManager.listPastSessions(req.userName!, projectName);
      res.json({ sessions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/sessions/:id/send', async (req: AuthRequest, res: Response) => {
    try {
      const id = req.params.id as string;
      if (!sessionManager.isUserSession(id, req.userName!)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const { message } = req.body;
      if (!message) {
        res.status(400).json({ error: 'Missing message' });
        return;
      }
      await sessionManager.sendMessage(id, message);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/sessions/:id/interrupt', async (req: AuthRequest, res: Response) => {
    try {
      const id = req.params.id as string;
      if (!sessionManager.isUserSession(id, req.userName!)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      await sessionManager.interruptSession(id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/sessions/:id', async (req: AuthRequest, res: Response) => {
    try {
      const id = req.params.id as string;
      if (!sessionManager.isUserSession(id, req.userName!)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      await sessionManager.closeSession(id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
