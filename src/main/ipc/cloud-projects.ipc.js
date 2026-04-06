/**
 * Cloud Projects IPC Handlers
 * Manages cloud project upload/download, user profile, sessions, and import.
 */

const { ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { zipProject } = require('../utils/zipProject');
const { execGit } = require('../utils/git');
const { getTokenForGit } = require('../services/GitHubAuthService');
const { _getCloudConfig, _fetchCloud, FETCH_DOWNLOAD_TIMEOUT_MS } = require('./cloud-shared');

let mainWindow = null;

/** @type {Set<string>} Locks to prevent concurrent uploads for the same project */
const _uploadLocks = new Set();

function registerCloudProjectsHandlers() {

  // ── Project upload (ZIP) ──

  ipcMain.handle('cloud:upload-project', async (_event, { projectId, projectName, projectPath }) => {
    if (_uploadLocks.has(projectId)) {
      throw new Error(`Upload already in progress for "${projectName}"`);
    }

    // Validate project path exists before attempting upload
    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project directory not found: ${projectPath}`);
    }

    const { url, key } = _getCloudConfig();
    const cloudKey = projectId;
    const zipPath = path.join(os.tmpdir(), `ct-upload-${Date.now()}.zip`);

    try {
      _uploadLocks.add(projectId);

      // Zip the project (include .git so cloud sessions can push/pull)
      await zipProject(projectPath, zipPath, (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cloud:upload-progress', { ...progress, projectId });
        }
      }, { includeGit: true });

      const zipSize = fs.statSync(zipPath).size;
      if (zipSize === 0) throw new Error('Generated zip is empty');
      const totalMB = Math.round(zipSize / 1024 / 1024);

      // Upload via multipart POST
      const FormData = require('form-data');
      const { PassThrough } = require('stream');
      const formData = new FormData();
      formData.append('name', cloudKey);
      formData.append('displayName', projectName);
      formData.append('zip', fs.createReadStream(zipPath), { filename: `${cloudKey}.zip`, contentType: 'application/zip' });

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:upload-progress', { phase: 'uploading', percent: 0, uploadedMB: 0, totalMB, projectId });
      }

      const http = url.startsWith('https') ? require('https') : require('http');
      const urlObj = new URL(`${url}/api/projects`);
      const formLength = await new Promise((res, rej) => formData.getLength((err, len) => err ? rej(err) : res(len)));

      // Dynamic timeout: 5 min minimum, or based on zip size at 1 MB/s
      const MIN_TIMEOUT_MS = 5 * 60 * 1000;
      const UPLOAD_TIMEOUT_MS = Math.max(MIN_TIMEOUT_MS, Math.round(zipSize / (1024 * 1024)) * 1000);

      const result = await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) { settled = true; req.destroy(); reject(new Error(`Upload timed out after ${Math.round(UPLOAD_TIMEOUT_MS / 1000)}s`)); }
        }, UPLOAD_TIMEOUT_MS);

        const req = http.request({
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            ...formData.getHeaders(),
            'Content-Length': formLength,
            'Authorization': `Bearer ${key}`,
          },
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => body += chunk);
          res.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try { resolve(JSON.parse(body)); } catch { resolve({ ok: true, raw: body }); }
            } else {
              let message;
              if (res.statusCode === 413) {
                const sizeMB = Math.round(zipSize / 1024 / 1024);
                message = `Project too large (${sizeMB} MB). Increase server upload limit (nginx client_max_body_size).`;
              } else {
                const textMatch = body.match(/<title>(.+?)<\/title>/i) || body.match(/<h1>(.+?)<\/h1>/i);
                message = textMatch ? `${res.statusCode} ${textMatch[1]}` : `HTTP ${res.statusCode}: ${body.substring(0, 200)}`;
              }
              reject(new Error(message));
            }
          });
        });
        req.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timeout); reject(err); } });

        // Track upload bytes for real progress
        let uploadedBytes = 0;
        let lastProgressPct = -1;
        const tracker = new PassThrough();
        tracker.on('data', (chunk) => {
          uploadedBytes += chunk.length;
          const pct = Math.min(Math.round((uploadedBytes / zipSize) * 100), 99);
          if (pct !== lastProgressPct) {
            lastProgressPct = pct;
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cloud:upload-progress', {
                phase: 'uploading', percent: pct,
                uploadedMB: Math.round(uploadedBytes / 1024 / 1024), totalMB, projectId,
              });
            }
          }
        });
        formData.pipe(tracker).pipe(req);
      });

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:upload-progress', { phase: 'done', percent: 100, projectId });
      }

      return { success: true, ...result };
    } finally {
      _uploadLocks.delete(projectId);
      await fs.promises.unlink(zipPath).catch(() => {});
    }
  });

  // ── Check if project has a GitHub remote ──

  ipcMain.handle('cloud:check-git-remote', async (_event, { projectPath }) => {
    const remoteUrl = await execGit(projectPath, 'remote get-url origin');
    if (!remoteUrl) return { hasGitHub: false };
    const isGitHub = remoteUrl.includes('github.com');
    return { hasGitHub: isGitHub, remoteUrl: remoteUrl.trim() };
  });

  // ── Upload project via git clone (faster than ZIP for GitHub repos) ──

  ipcMain.handle('cloud:upload-project-git', async (_event, { projectId, projectName, projectPath }) => {
    if (_uploadLocks.has(projectId)) {
      throw new Error(`Upload already in progress for "${projectName}"`);
    }

    // Validate project path exists before attempting upload
    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project directory not found: ${projectPath}`);
    }

    try {
      _uploadLocks.add(projectId);

      const { url, key } = _getCloudConfig();
      const cloudKey = projectId;

      // Get GitHub token
      const token = await getTokenForGit();
      if (!token) throw new Error('No GitHub token found. Please connect your GitHub account first.');

      // Get remote URL
      const remoteUrl = await execGit(projectPath, 'remote get-url origin');
      if (!remoteUrl || !remoteUrl.includes('github.com')) {
        throw new Error('Project does not have a GitHub remote configured.');
      }

      // Build authenticated HTTPS clone URL
      let cloneUrl = remoteUrl.trim();
      if (cloneUrl.startsWith('git@github.com:')) {
        cloneUrl = 'https://github.com/' + cloneUrl.replace('git@github.com:', '');
        if (!cloneUrl.endsWith('.git')) cloneUrl += '.git';
      }
      cloneUrl = cloneUrl.replace('https://github.com/', `https://${token}@github.com/`);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:upload-progress', { phase: 'cloning', percent: 10, projectId });
      }

      // Ask cloud server to git clone
      const cloneResp = await _fetchCloud(`${url}/api/projects/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ name: cloudKey, cloneUrl, displayName: projectName }),
      }, 5 * 60 * 1000);

      if (!cloneResp.ok) {
        const body = await cloneResp.text();
        throw new Error(`Clone failed: HTTP ${cloneResp.status}: ${body.substring(0, 200)}`);
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:upload-progress', { phase: 'done', percent: 100, projectId });
      }

      return { success: true, method: 'git-clone' };
    } finally {
      _uploadLocks.delete(projectId);
    }
  });

  // ── Delete project from cloud ──

  ipcMain.handle('cloud:delete-project', async (_event, { projectId }) => {
    const { url, key } = _getCloudConfig();
    const resp = await _fetchCloud(`${url}/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    return { ok: true };
  });

  // ── Update cloud project display name ──

  ipcMain.handle('cloud:update-display-name', async (_event, { projectId, displayName }) => {
    const { url, key } = _getCloudConfig();
    const resp = await _fetchCloud(`${url}/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    return { ok: true };
  });

  // ── User profile ──

  ipcMain.handle('cloud:get-user', async () => {
    const { url, key } = _getCloudConfig();
    const resp = await _fetchCloud(`${url}/api/me`, {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!resp.ok) throw new Error(await resp.text());
    return resp.json();
  });

  ipcMain.handle('cloud:update-user', async (_event, { gitName, gitEmail }) => {
    const { url, key } = _getCloudConfig();
    const resp = await _fetchCloud(`${url}/api/me`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitName, gitEmail }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    return resp.json();
  });

  // ── Cloud sessions ──

  ipcMain.handle('cloud:get-sessions', async () => {
    const { url, key } = _getCloudConfig();
    const resp = await _fetchCloud(`${url}/api/sessions`, {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!resp.ok) throw new Error(await resp.text());
    return resp.json();
  });

  ipcMain.handle('cloud:stop-session', async (_event, { sessionId }) => {
    const { url, key } = _getCloudConfig();
    const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
    await _fetchCloud(`${url}/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST', headers });
    await _fetchCloud(`${url}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers });
    return { ok: true };
  });

  // ── Cloud projects list ──

  ipcMain.handle('cloud:get-projects', async () => {
    const { url, key } = _getCloudConfig();
    const resp = await _fetchCloud(`${url}/api/projects`, {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!resp.ok) throw new Error(await resp.text());
    return resp.json();
  });

  // ── Import cloud project to local machine ──

  ipcMain.handle('cloud:import-project', async (_event, { projectName, displayName }) => {
    const { url, key } = _getCloudConfig();
    const extractZip = require('extract-zip');
    const { dialog } = require('electron');

    const folderName = displayName || projectName;

    // Ask user where to import the project
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: `Import "${folderName}"`,
      buttonLabel: 'Import here',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths.length) return { canceled: true };

    const parentFolder = filePaths[0];
    const destFolder = path.join(parentFolder, folderName);
    const tmpZip = path.join(os.tmpdir(), `ct-import-${Date.now()}.zip`);

    try {
      // Download zip (5 min timeout for large projects)
      const resp = await _fetchCloud(
        `${url}/api/projects/${encodeURIComponent(projectName)}/download`,
        { headers: { 'Authorization': `Bearer ${key}` } },
        300_000
      );
      if (!resp.ok) throw new Error(await resp.text());

      const buffer = Buffer.from(await resp.arrayBuffer());
      await fs.promises.writeFile(tmpZip, buffer);

      // Extract to destination
      await fs.promises.mkdir(destFolder, { recursive: true });
      await extractZip(tmpZip, { dir: destFolder });

      return { projectPath: destFolder, projectName: folderName, cloudProjectId: projectName };
    } finally {
      await fs.promises.unlink(tmpZip).catch(() => {});
    }
  });
}

function setCloudProjectsMainWindow(win) {
  mainWindow = win;
}

module.exports = { registerCloudProjectsHandlers, setCloudProjectsMainWindow };
