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
import { RelayServer } from '../relay/RelayServer';
import { syncManager } from './SyncManager';

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
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only .zip files are accepted'));
    }
  }
});

// ── Webhook rate limiter (per user, 60 req/min) ──
const WEBHOOK_RATE_LIMIT = 60;
const WEBHOOK_RATE_WINDOW_MS = 60_000;
const MAX_WEBHOOK_PAYLOAD = 256 * 1024; // 256 KB
const _webhookRates = new Map<string, { count: number; resetAt: number }>();

function isWebhookRateLimited(userName: string): boolean {
  const now = Date.now();
  let entry = _webhookRates.get(userName);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WEBHOOK_RATE_WINDOW_MS };
    _webhookRates.set(userName, entry);
  }
  entry.count++;
  return entry.count > WEBHOOK_RATE_LIMIT;
}

export function createCloudRouter(relay?: RelayServer): Router {
  const router = Router();

  // ── Webhook endpoint (auth via Bearer token, before general authMiddleware) ──
  // Placed before authMiddleware so we can return fast with appropriate status codes

  router.post('/webhook/:workflowId', authMiddleware as any, async (req: AuthRequest, res: Response) => {
    try {
      const userName = req.userName!;
      const workflowId = req.params.workflowId as string;

      if (!workflowId || workflowId.length > 128) {
        res.status(400).json({ error: 'Invalid workflowId' });
        return;
      }

      // Payload size check (express.json() already parsed, check stringified size)
      const payloadStr = JSON.stringify(req.body || {});
      if (payloadStr.length > MAX_WEBHOOK_PAYLOAD) {
        res.status(413).json({ error: 'Payload too large (max 256 KB)' });
        return;
      }

      // Rate limit
      if (isWebhookRateLimited(userName)) {
        res.status(429).json({ error: 'Rate limit exceeded (60 req/min)' });
        return;
      }

      // Find user's room and forward to desktop
      if (!relay) {
        res.status(503).json({ error: 'Relay server not available' });
        return;
      }

      const room = relay.getRoomForUser(userName);
      if (!room || !room.hasDesktop) {
        res.status(503).json({ error: 'Desktop not connected' });
        return;
      }

      const sent = room.sendToDesktop({
        type: 'webhook:trigger',
        data: {
          workflowId,
          payload: req.body || {},
          triggeredAt: new Date().toISOString(),
        },
      });

      if (sent) {
        console.log(`[Webhook] ${userName} → workflow ${workflowId} (forwarded to desktop)`);
        res.json({ ok: true, workflowId });
      } else {
        res.status(503).json({ error: 'Failed to send to desktop' });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.use(authMiddleware as any);

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

      relay?.notifyRoom(req.userName!, { type: 'cloud:project-updated', projectId: name, displayName: displayName || name, timestamp: Date.now() });
      res.status(201).json({ name, displayName: displayName || name, path: projectPath });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Apply a git patch + untracked files sent as multipart form
  const patchUpload = multer({
    dest: path.join(os.tmpdir(), 'ct-cloud-patches'),
    limits: { fileSize: 50 * 1024 * 1024 },
  });
  router.post('/projects/:name/patch', patchUpload.fields([
    { name: 'patch', maxCount: 1 },
    { name: 'untracked', maxCount: 500 },
  ]), async (req: AuthRequest, res: Response) => {
    try {
      const name = req.params.name as string;
      const projectPath = store.getProjectPath(req.userName!, name);
      const files = req.files as Record<string, Express.Multer.File[]>;

      // Apply git patch if present
      if (files?.patch?.[0]) {
        const patchFile = files.patch[0].path;
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const execFileAsync = promisify(execFile);
        try {
          await execFileAsync('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: projectPath, timeout: 30000 });
        } catch (err: any) {
          // Non-fatal: patch may fail if already applied or no changes
          console.warn(`[Cloud] git apply warning for ${name}: ${err.message}`);
        } finally {
          await fs.promises.unlink(patchFile).catch(() => {});
        }
      }

      // Write untracked files
      if (files?.untracked) {
        for (const file of files.untracked) {
          const dest = path.join(projectPath, file.originalname);
          await fs.promises.mkdir(path.dirname(dest), { recursive: true });
          await fs.promises.copyFile(file.path, dest);
          await fs.promises.unlink(file.path).catch(() => {});
        }
      }

      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/projects', upload.single('zip'), async (req: AuthRequest, res: Response) => {
    try {
      const name = req.body?.name;
      const displayName = req.body?.displayName || name;
      if (!name) {
        res.status(400).json({ error: 'Missing project name' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'Missing zip file' });
        return;
      }

      const projectPath = await projectManager.createFromZip(req.userName!, name, req.file.path, displayName);
      relay?.notifyRoom(req.userName!, { type: 'cloud:project-updated', projectId: name, displayName, timestamp: Date.now() });
      res.status(201).json({ name, displayName, path: projectPath });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/projects/:name/sync', upload.single('zip'), async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Missing zip file' });
        return;
      }
      const name = req.params.name as string;
      await projectManager.syncProject(req.userName!, name, req.file.path);
      relay?.notifyRoom(req.userName!, { type: 'cloud:project-updated', projectId: name, timestamp: Date.now() });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Incremental sync (only changed files + .DELETED markers)
  router.patch('/projects/:name/sync', upload.single('zip'), async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Missing zip file' });
        return;
      }
      const name = req.params.name as string;
      const result = await projectManager.patchProject(req.userName!, name, req.file.path);
      relay?.notifyRoom(req.userName!, { type: 'cloud:project-updated', projectId: name, timestamp: Date.now() });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // List all files in a cloud project (for diff comparison)
  router.get('/projects/:name/files', async (req: AuthRequest, res: Response) => {
    try {
      const name = req.params.name as string;
      const files = await projectManager.listProjectFiles(req.userName!, name);
      res.json({ files });
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

  // ── File hashes (for accurate diff comparison) ──

  router.post('/projects/:name/files/hashes', async (req: AuthRequest, res: Response) => {
    try {
      const name = req.params.name as string;
      const { filePaths } = req.body;
      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        res.status(400).json({ error: 'Missing or empty filePaths array' });
        return;
      }
      if (filePaths.length > 5000) {
        res.status(400).json({ error: 'Too many files (max 5000)' });
        return;
      }
      const hashes = await projectManager.hashProjectFiles(req.userName!, name, filePaths);
      res.json({ hashes });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Project Changes (for sync) ──

  router.get('/projects/:name/changes', async (req: AuthRequest, res: Response) => {
    try {
      const name = req.params.name as string;
      const changes = await projectManager.getUnsyncedChanges(req.userName!, name);
      res.json({ changes });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/projects/:name/changes/download', async (req: AuthRequest, res: Response) => {
    try {
      const name = req.params.name as string;
      const zipStream = await projectManager.downloadChangesZip(req.userName!, name);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${name}-changes.zip"`);
      (zipStream as any).pipe(res);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/projects/:name/changes/ack', async (req: AuthRequest, res: Response) => {
    try {
      const name = req.params.name as string;
      await projectManager.acknowledgeChanges(req.userName!, name);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
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

  // ── Entity Sync ──

  router.get('/sync/state', async (req: AuthRequest, res: Response) => {
    try {
      const state = await syncManager.getState(req.userName!);
      res.json(state);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/sync/push', async (req: AuthRequest, res: Response) => {
    try {
      const { entityType, entityId, data, hash, timestamp } = req.body;
      if (!entityType || typeof entityType !== 'string') {
        res.status(400).json({ error: 'Missing or invalid entityType' });
        return;
      }
      await syncManager.pushEntity(
        req.userName!,
        entityType,
        entityId || null,
        data,
        hash || '',
        typeof timestamp === 'number' ? timestamp : Date.now(),
      );
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/sync/conversation/:id', async (req: AuthRequest, res: Response) => {
    try {
      const id = req.params.id as string;
      const content = await syncManager.getConversation(req.userName!, id);
      if (content === null) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      res.json({ content });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/sync/conversation/:id', async (req: AuthRequest, res: Response) => {
    try {
      const id = req.params.id as string;
      const { appendLines, totalLineCount } = req.body;
      if (!appendLines || typeof appendLines !== 'string') {
        res.status(400).json({ error: 'Missing or invalid appendLines' });
        return;
      }
      await syncManager.appendConversation(
        req.userName!,
        id,
        appendLines,
        typeof totalLineCount === 'number' ? totalLineCount : 0,
      );
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
      const { projectName, prompt, model, effort } = req.body;
      if (!projectName || !prompt) {
        res.status(400).json({ error: 'Missing projectName or prompt' });
        return;
      }

      console.log(`[API] POST /sessions user=${req.userName} project=${projectName} model=${model || 'default'}`);
      const sessionId = await sessionManager.createSession(req.userName!, projectName, prompt, model, effort);
      console.log(`[API] Session created: ${sessionId}`);
      res.status(201).json({ sessionId });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
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
