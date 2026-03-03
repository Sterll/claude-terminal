/**
 * Cloud IPC Handlers
 * Bridge between renderer and CloudRelayClient for relay/cloud features.
 * Routes cloud relay messages through RemoteServer so cloud mobiles
 * get the same experience as local Wi-Fi clients.
 */

const { ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { cloudRelayClient } = require('../services/CloudRelayClient');
const remoteServer = require('../services/RemoteServer');
const cloudSyncService = require('../services/CloudSyncService');
const { sendFeaturePing } = require('../services/TelemetryService');
const { zipProject } = require('../utils/zipProject');
const { settingsFile } = require('../utils/paths');
const { execGit } = require('../utils/git');
const { getTokenForGit } = require('../services/GitHubAuthService');

let mainWindow = null;

/** @type {Set<string>} Locks to prevent concurrent uploads for the same project */
const _uploadLocks = new Set();

function _loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function _getCloudConfig() {
  const settings = _loadSettings();
  const url = settings.cloudServerUrl;
  const key = settings.cloudApiKey;
  if (!url || !key) throw new Error('Cloud not configured');
  return { url: url.replace(/\/$/, ''), key };
}

function registerCloudHandlers() {
  // Wire callbacks once (they just register listeners, not start anything)
  cloudRelayClient.onMessage((msg) => {
    remoteServer.handleCloudMessage(msg);
  });

  cloudRelayClient.onStatusChange((status) => {
    if (status.connected) {
      remoteServer.sendInitToCloud();
      cloudSyncService.start();
      // Check for pending changes from headless sessions
      setImmediate(() => _checkPendingChangesOnReconnect());
      // Auto-sync skills if enabled
      setImmediate(async () => {
        try {
          const settings = _loadSettings();
          if (settings.cloudSyncSkills) {
            const result = await _syncSkillsToCloud();
            console.log(`[Cloud] Auto skills sync: ${result.skillCount} skill(s), ${result.agentCount} agent(s)`);
          }
        } catch (e) {
          console.warn('[Cloud] Auto skills sync failed:', e.message);
        }
      });
    }
    // Note: we do NOT call setCloudClient(null) here on disconnect because
    // CloudRelayClient auto-reconnects. Only explicit cloud:disconnect clears it.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cloud:status-changed', status);
    }
  });

  // ── Relay connect/disconnect ──

  ipcMain.handle('cloud:connect', async (_event, { serverUrl, apiKey }) => {
    sendFeaturePing('cloud:connect');
    if (remoteServer.getServerInfo().running) {
      remoteServer.stop();
    }
    remoteServer.setCloudClient(cloudRelayClient);
    cloudRelayClient.connect(serverUrl, apiKey);
    return { ok: true };
  });

  ipcMain.handle('cloud:disconnect', async () => {
    cloudRelayClient.disconnect();
    remoteServer.setCloudClient(null);
    cloudSyncService.stop();
    return { ok: true };
  });

  ipcMain.handle('cloud:status', async () => {
    return cloudRelayClient.getStatus();
  });

  ipcMain.on('cloud:send', (_event, data) => {
    cloudRelayClient.send(data);
  });

  // ── Project upload ──

  ipcMain.handle('cloud:upload-project', async (_event, { projectName, projectPath }) => {
    if (_uploadLocks.has(projectName)) {
      throw new Error(`Upload already in progress for "${projectName}"`);
    }
    _uploadLocks.add(projectName);

    const { url, key } = _getCloudConfig();
    const zipPath = path.join(os.tmpdir(), `ct-upload-${Date.now()}.zip`);

    try {
      // Zip the project (include .git so cloud sessions can push/pull)
      await zipProject(projectPath, zipPath, (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cloud:upload-progress', progress);
        }
      }, { includeGit: true });

      // Upload via multipart POST
      const FormData = require('form-data');
      const { PassThrough } = require('stream');
      const formData = new FormData();
      formData.append('name', projectName);
      formData.append('zip', fs.createReadStream(zipPath), { filename: `${projectName}.zip`, contentType: 'application/zip' });

      const zipSize = fs.statSync(zipPath).size;
      const totalMB = Math.round(zipSize / 1024 / 1024);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:upload-progress', { phase: 'uploading', percent: 0, uploadedMB: 0, totalMB });
      }

      const http = url.startsWith('https') ? require('https') : require('http');
      const urlObj = new URL(`${url}/api/projects`);

      // Get total form length (needed because PassThrough breaks form-data's auto Content-Length)
      const formLength = await new Promise((res, rej) => formData.getLength((err, len) => err ? rej(err) : res(len)));

      // Dynamic timeout: 5 min minimum, or based on zip size at 1 MB/s (slow connection baseline)
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
                const sizeMB = Math.round(fs.statSync(zipPath).size / 1024 / 1024);
                message = `Project too large (${sizeMB} MB). Increase server upload limit (nginx client_max_body_size).`;
              } else {
                // Try to extract text from HTML responses
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
          // Throttle: only send when percentage changes
          if (pct !== lastProgressPct) {
            lastProgressPct = pct;
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cloud:upload-progress', {
                phase: 'uploading', percent: pct,
                uploadedMB: Math.round(uploadedBytes / 1024 / 1024), totalMB,
              });
            }
          }
        });
        formData.pipe(tracker).pipe(req);
      });

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:upload-progress', { phase: 'done', percent: 100 });
      }

      return { success: true, ...result };
    } finally {
      _uploadLocks.delete(projectName);
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

  ipcMain.handle('cloud:upload-project-git', async (_event, { projectName, projectPath }) => {
    if (_uploadLocks.has(projectName)) {
      throw new Error(`Upload already in progress for "${projectName}"`);
    }
    _uploadLocks.add(projectName);

    try {
      const { url, key } = _getCloudConfig();

      // Get GitHub token
      const token = await getTokenForGit();
      if (!token) throw new Error('No GitHub token found. Please connect your GitHub account first.');

      // Get remote URL
      const remoteUrl = await execGit(projectPath, 'remote get-url origin');
      if (!remoteUrl || !remoteUrl.includes('github.com')) {
        throw new Error('Project does not have a GitHub remote configured.');
      }

      // Build authenticated HTTPS clone URL (handle both HTTPS and SSH remotes)
      let cloneUrl = remoteUrl.trim();
      if (cloneUrl.startsWith('git@github.com:')) {
        cloneUrl = 'https://github.com/' + cloneUrl.replace('git@github.com:', '');
        if (!cloneUrl.endsWith('.git')) cloneUrl += '.git';
      }
      cloneUrl = cloneUrl.replace('https://github.com/', `https://${token}@github.com/`);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:upload-progress', { phase: 'cloning', percent: 10 });
      }

      // Ask cloud server to git clone
      const cloneResp = await _fetchCloud(`${url}/api/projects/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ name: projectName, cloneUrl }),
      }, 5 * 60 * 1000);

      if (!cloneResp.ok) {
        const body = await cloneResp.text();
        throw new Error(`Clone failed: HTTP ${cloneResp.status}: ${body.substring(0, 200)}`);
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:upload-progress', { phase: 'patching', percent: 70 });
      }

      // Generate diffs: unpushed commits + working tree changes + untracked files
      const patchParts = [];

      // Commits not yet pushed to remote
      const unpushedPatch = await execGit(projectPath, 'format-patch @{u}..HEAD --stdout', 30000);
      if (unpushedPatch) patchParts.push(unpushedPatch);

      // Working tree diffs (staged + unstaged vs HEAD)
      const workingDiff = await execGit(projectPath, 'diff HEAD', 15000);
      if (workingDiff) patchParts.push(workingDiff);

      // Untracked files
      const untrackedOutput = await execGit(projectPath, 'ls-files --others --exclude-standard', 10000);
      const untrackedFiles = untrackedOutput ? untrackedOutput.split('\n').filter(Boolean) : [];

      // Send patch if there's anything to apply
      if (patchParts.length > 0 || untrackedFiles.length > 0) {
        const FormData = require('form-data');
        const formData = new FormData();

        if (patchParts.length > 0) {
          const patchContent = Buffer.from(patchParts.join('\n'), 'utf8');
          formData.append('patch', patchContent, { filename: 'changes.patch', contentType: 'text/plain' });
        }

        for (const file of untrackedFiles) {
          const fullPath = path.join(projectPath, file);
          try {
            const content = fs.readFileSync(fullPath);
            formData.append('untracked', content, { filename: file, contentType: 'application/octet-stream' });
          } catch (_) {}
        }

        const http = url.startsWith('https') ? require('https') : require('http');
        const urlObj = new URL(`${url}/api/projects/${encodeURIComponent(projectName)}/patch`);
        const formLength = await new Promise((res, rej) => formData.getLength((err, len) => err ? rej(err) : res(len)));

        await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname,
            method: 'POST',
            headers: { ...formData.getHeaders(), 'Content-Length': formLength, 'Authorization': `Bearer ${key}` },
          }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) resolve();
              else reject(new Error(`Patch failed: HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
            });
          });
          req.on('error', reject);
          formData.pipe(req);
        });
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:upload-progress', { phase: 'done', percent: 100 });
      }

      return { success: true, method: 'git-clone' };
    } finally {
      _uploadLocks.delete(projectName);
    }
  });

  // ── Delete project from cloud ──

  ipcMain.handle('cloud:delete-project', async (_event, { projectId, projectName }) => {
    const { url, key } = _getCloudConfig();
    const resp = await _fetchCloud(`${url}/api/projects/${encodeURIComponent(projectName)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    // Stop file watcher and unregister from auto-sync
    if (projectId) {
      cloudSyncService.unregisterProject(projectId);
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

  // ── Check pending changes from headless sessions ──

  ipcMain.handle('cloud:check-pending-changes', async () => {
    try {
      const { url, key } = _getCloudConfig();
      const headers = { 'Authorization': `Bearer ${key}` };

      const projectsResp = await _fetchCloud(`${url}/api/projects`, { headers });
      if (!projectsResp.ok) return { changes: [] };
      const { projects } = await projectsResp.json();

      const allChanges = [];
      for (const project of projects) {
        const changesResp = await _fetchCloud(`${url}/api/projects/${encodeURIComponent(project.name)}/changes`, { headers });
        if (!changesResp.ok) continue;
        const { changes } = await changesResp.json();
        if (changes.length > 0) {
          allChanges.push({ projectName: project.name, changes });
        }
      }
      return { changes: allChanges };
    } catch {
      return { changes: [] };
    }
  });

  // ── Download and apply changes ──

  ipcMain.handle('cloud:download-changes', async (_event, { projectName, localProjectPath }) => {
    const { url, key } = _getCloudConfig();
    const headers = { 'Authorization': `Bearer ${key}` };

    // Download changes zip (longer timeout for file transfer)
    const resp = await _fetchCloud(`${url}/api/projects/${encodeURIComponent(projectName)}/changes/download`, { headers }, FETCH_DOWNLOAD_TIMEOUT_MS);
    if (!resp.ok) throw new Error('Failed to download changes');

    const zipPath = path.join(os.tmpdir(), `ct-sync-${Date.now()}.zip`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    await fs.promises.writeFile(zipPath, buffer);

    let extracted = false;
    try {
      // Extract to project dir (overwrite existing files)
      const extractZip = require('extract-zip');
      await extractZip(zipPath, { dir: localProjectPath });

      // Handle .DELETED markers
      await _handleDeletedMarkers(localProjectPath);
      extracted = true;
    } finally {
      await fs.promises.unlink(zipPath).catch(() => {});
    }

    // Only acknowledge AFTER verified successful extraction
    if (extracted) {
      await _fetchCloud(`${url}/api/projects/${encodeURIComponent(projectName)}/changes/ack`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    return { success: extracted };
  });

  // ── Takeover a running cloud session ──

  ipcMain.handle('cloud:takeover-session', async (_event, { sessionId, projectName, localProjectPath }) => {
    const { url, key } = _getCloudConfig();
    const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };

    // Interrupt the cloud session
    await _fetchCloud(`${url}/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
      method: 'POST', headers,
    });

    // Download any file changes
    try {
      const changesResp = await _fetchCloud(`${url}/api/projects/${encodeURIComponent(projectName)}/changes`, {
        headers: { 'Authorization': `Bearer ${key}` },
      });
      const { changes } = await changesResp.json();

      if (changes && changes.length > 0 && localProjectPath) {
        const resp = await _fetchCloud(`${url}/api/projects/${encodeURIComponent(projectName)}/changes/download`, {
          headers: { 'Authorization': `Bearer ${key}` },
        }, FETCH_DOWNLOAD_TIMEOUT_MS);
        if (resp.ok) {
          const zipPath = path.join(os.tmpdir(), `ct-takeover-${Date.now()}.zip`);
          const buffer = Buffer.from(await resp.arrayBuffer());
          await fs.promises.writeFile(zipPath, buffer);

          let extracted = false;
          try {
            const extractZip = require('extract-zip');
            await extractZip(zipPath, { dir: localProjectPath });
            await _handleDeletedMarkers(localProjectPath);
            extracted = true;
          } finally {
            await fs.promises.unlink(zipPath).catch(() => {});
          }

          // Only ack after verified successful extraction
          if (extracted) {
            await _fetchCloud(`${url}/api/projects/${encodeURIComponent(projectName)}/changes/ack`, {
              method: 'POST', headers,
            });
          }
        }
      }
    } catch (err) {
      console.warn('[Cloud] Failed to sync changes during takeover:', err.message);
    }

    // Close the cloud session
    await _fetchCloud(`${url}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE', headers,
    });

    return { success: true };
  });

  // ── Sync status ──

  ipcMain.handle('cloud:get-sync-status', async (_event, { projectId }) => {
    if (projectId) return cloudSyncService.getSyncStatus(projectId);
    return cloudSyncService.getAllSyncStatuses();
  });

  // ── Auto-sync registration ──

  ipcMain.handle('cloud:register-auto-sync', async (_event, { projectId, projectPath }) => {
    cloudSyncService.registerProject(projectId, projectPath);
    return { ok: true };
  });

  ipcMain.handle('cloud:unregister-auto-sync', async (_event, { projectId }) => {
    cloudSyncService.unregisterProject(projectId);
    return { ok: true };
  });

  // ── Skills & Agents sync ──

  ipcMain.handle('cloud:sync-skills', async () => {
    return _syncSkillsToCloud();
  });

  // ── File comparison (local vs cloud) ──

  ipcMain.handle('cloud:compare-files', async (_event, { projectName, localProjectPath }) => {
    const { url, key } = _getCloudConfig();

    // Fetch cloud file list
    const resp = await _fetchCloud(
      `${url}/api/projects/${encodeURIComponent(projectName)}/files`,
      { headers: { 'Authorization': `Bearer ${key}` } }
    );
    if (!resp.ok) throw new Error('Failed to fetch cloud files');
    const { files: cloudFiles } = await resp.json();
    const cloudMap = new Map(cloudFiles.map(f => [f.path, f.size]));

    // Scan local files
    const EXCLUDE = new Set([
      'node_modules', '.git', 'build', 'dist', '.next', '__pycache__',
      '.venv', 'venv', '.cache', 'coverage', '.tsbuildinfo', '.ct-cloud',
      '.turbo', '.parcel-cache', '.svelte-kit', '.nuxt', '.output',
    ]);
    const localMap = new Map();
    _scanLocalFiles(localProjectPath, localProjectPath, EXCLUDE, localMap);

    const onlyLocal = [];   // files on PC but not in cloud
    const onlyCloud = [];   // files in cloud but not on PC
    const sizeDiff = [];    // files in both but different size

    for (const [filePath, size] of localMap) {
      if (!cloudMap.has(filePath)) {
        onlyLocal.push(filePath);
      } else if (cloudMap.get(filePath) !== size) {
        sizeDiff.push(filePath);
      }
    }

    for (const [filePath] of cloudMap) {
      if (!localMap.has(filePath)) {
        onlyCloud.push(filePath);
      }
    }

    return { onlyLocal, onlyCloud, sizeDiff, totalLocal: localMap.size, totalCloud: cloudMap.size };
  });

  // ── Conflict detection ──

  ipcMain.handle('cloud:check-conflicts', async (_event, { projectName, localProjectPath }) => {
    const { url, key } = _getCloudConfig();
    const headers = { 'Authorization': `Bearer ${key}` };

    const changesResp = await _fetchCloud(
      `${url}/api/projects/${encodeURIComponent(projectName)}/changes`,
      { headers }
    );
    if (!changesResp.ok) throw new Error('Failed to check changes');
    const { changes } = await changesResp.json();

    const cloudFiles = changes.flatMap(c => c.changedFiles || []);
    const conflicts = [];

    for (const file of cloudFiles) {
      const localPath = path.join(localProjectPath, file);
      if (!fs.existsSync(localPath)) continue;

      try {
        const stat = fs.statSync(localPath);
        // Find the matching project to get its sync timestamp
        const projectsData = JSON.parse(fs.readFileSync(require('../utils/paths').projectsFile, 'utf8'));
        const project = (projectsData.projects || []).find(p => p.path === localProjectPath);
        const lastSync = project ? cloudSyncService.getLastSyncTimestamp(project.id) : null;

        if (lastSync && stat.mtimeMs > lastSync) {
          conflicts.push({ file, localModified: new Date(stat.mtimeMs).toISOString() });
        }
      } catch {
        // Can't stat, not a conflict
      }
    }

    return { conflicts, totalFiles: cloudFiles.length };
  });

  // ── Download with conflict resolutions ──

  ipcMain.handle('cloud:download-with-resolutions', async (_event, { projectName, localProjectPath, resolutions }) => {
    const { url, key } = _getCloudConfig();
    const headers = { 'Authorization': `Bearer ${key}` };

    const resp = await _fetchCloud(
      `${url}/api/projects/${encodeURIComponent(projectName)}/changes/download`,
      { headers }, FETCH_DOWNLOAD_TIMEOUT_MS
    );
    if (!resp.ok) throw new Error('Failed to download changes');

    const zipPath = path.join(os.tmpdir(), `ct-conflict-${Date.now()}.zip`);
    const extractDir = path.join(os.tmpdir(), `ct-conflict-extract-${Date.now()}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    await fs.promises.writeFile(zipPath, buffer);

    try {
      const extractZip = require('extract-zip');
      await extractZip(zipPath, { dir: extractDir });

      // Apply per-file resolutions for conflicting files
      for (const [file, resolution] of Object.entries(resolutions)) {
        const cloudFile = path.join(extractDir, file);
        const localFile = path.join(localProjectPath, file);

        if (resolution === 'local') {
          // Keep local version — skip
          continue;
        } else if (resolution === 'both') {
          // Backup local version before overwriting
          if (fs.existsSync(localFile)) {
            const ext = path.extname(file);
            const base = file.slice(0, -ext.length || undefined);
            const backupPath = path.join(localProjectPath, `${base}.local-backup${ext}`);
            await fs.promises.copyFile(localFile, backupPath);
          }
        }
        // resolution === 'cloud' or 'both': apply cloud version
        if (fs.existsSync(cloudFile)) {
          const dir = path.dirname(localFile);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          await fs.promises.copyFile(cloudFile, localFile);
        }
      }

      // Apply non-conflicting files by extracting directly
      const allFiles = await _walkExtracted(extractDir);
      for (const relPath of allFiles) {
        if (resolutions[relPath]) continue; // Already handled
        if (relPath.endsWith('.DELETED')) continue; // Handle below
        const src = path.join(extractDir, relPath);
        const dest = path.join(localProjectPath, relPath);
        const dir = path.dirname(dest);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        await fs.promises.copyFile(src, dest);
      }

      // Handle .DELETED markers
      await _handleDeletedMarkers(localProjectPath);

      // Acknowledge
      await _fetchCloud(
        `${url}/api/projects/${encodeURIComponent(projectName)}/changes/ack`,
        { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } }
      );

      // Update sync timestamp
      const projectsData = JSON.parse(fs.readFileSync(require('../utils/paths').projectsFile, 'utf8'));
      const project = (projectsData.projects || []).find(p => p.path === localProjectPath);
      if (project) cloudSyncService.updateSyncTimestamp(project.id);
    } finally {
      await fs.promises.unlink(zipPath).catch(() => {});
      await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }

    return { success: true };
  });
}

// ── Helpers ──

const FETCH_TIMEOUT_MS = 10000;
const FETCH_DOWNLOAD_TIMEOUT_MS = 60000;

/**
 * Fetch with timeout via AbortController.
 * @param {string} url
 * @param {RequestInit} opts
 * @param {number} [timeoutMs]
 */
async function _syncSkillsToCloud() {
  const { url, key } = _getCloudConfig();
  const claudeDir = path.join(os.homedir(), '.claude');
  const skillsDir = path.join(claudeDir, 'skills');
  const agentsDir = path.join(claudeDir, 'agents');
  const zipPath = path.join(os.tmpdir(), `ct-skills-sync-${Date.now()}.zip`);

  try {
    const archiver = require('archiver');
    let skillCount = 0;
    let agentCount = 0;

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      // Add skills/ directory
      if (fs.existsSync(skillsDir)) {
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
          if (!fs.existsSync(skillMd)) continue;
          archive.directory(path.join(skillsDir, entry.name), `skills/${entry.name}`);
          skillCount++;
        }
      }

      // Add agents/ directory
      if (fs.existsSync(agentsDir)) {
        const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(agentsDir, entry.name);
          if (entry.isFile() && entry.name.endsWith('.md')) {
            archive.file(fullPath, { name: `agents/${entry.name}` });
            agentCount++;
          } else if (entry.isDirectory()) {
            const agentMd = path.join(fullPath, 'AGENT.md');
            if (fs.existsSync(agentMd)) {
              archive.directory(fullPath, `agents/${entry.name}`);
              agentCount++;
            }
          }
        }
      }

      archive.finalize();
    });

    if (skillCount === 0 && agentCount === 0) {
      return { ok: true, skillCount: 0, agentCount: 0 };
    }

    // Upload via PUT /api/skills (multipart)
    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('zip', fs.createReadStream(zipPath), { filename: 'skills.zip', contentType: 'application/zip' });

    const headers = { ...formData.getHeaders(), 'Authorization': `Bearer ${key}` };
    const resp = await _fetchCloud(`${url}/api/skills`, {
      method: 'PUT',
      headers,
      body: formData,
      duplex: 'half',
    }, 30000);

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Skills sync failed: HTTP ${resp.status} ${text.substring(0, 200)}`);
    }

    console.log(`[Cloud] Skills synced: ${skillCount} skill(s), ${agentCount} agent(s)`);
    return { ok: true, skillCount, agentCount };
  } finally {
    await fs.promises.unlink(zipPath).catch(() => {});
  }
}

async function _fetchCloud(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function _scanLocalFiles(baseDir, currentDir, excludeSet, resultMap) {
  let entries;
  try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (excludeSet.has(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      _scanLocalFiles(baseDir, fullPath, excludeSet, resultMap);
    } else {
      try {
        const stat = fs.statSync(fullPath);
        const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        resultMap.set(rel, stat.size);
      } catch { /* skip */ }
    }
  }
}

async function _walkExtracted(dir, rootDir = null) {
  if (!rootDir) rootDir = dir;
  const files = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await _walkExtracted(fullPath, rootDir));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, fullPath).replace(/\\/g, '/'));
    }
  }
  return files;
}

async function _handleDeletedMarkers(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.DELETED')) {
        // Node >=20.12 uses parentPath, older uses path — both refer to the parent dir
        const parentDir = entry.parentPath || entry.path;
        const markerPath = path.join(parentDir, entry.name);
        const originalPath = markerPath.replace(/\.DELETED$/, '');
        await fs.promises.unlink(originalPath).catch(() => {});
        await fs.promises.unlink(markerPath).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('[Cloud] Error handling deleted markers:', e.message);
  }
}

async function _checkPendingChangesOnReconnect() {
  try {
    const { url, key } = _getCloudConfig();
    const headers = { 'Authorization': `Bearer ${key}` };

    // Check for active headless sessions
    const sessionsResp = await _fetchCloud(`${url}/api/sessions`, { headers });
    if (sessionsResp.ok) {
      const { sessions } = await sessionsResp.json();
      const activeSessions = sessions.filter(s => s.status === 'running');
      if (activeSessions.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:headless-active', { sessions: activeSessions });
      }
    }

    // Check for pending file changes
    const projectsResp = await _fetchCloud(`${url}/api/projects`, { headers });
    if (projectsResp.ok) {
      const { projects } = await projectsResp.json();
      const allChanges = [];
      for (const project of projects) {
        const changesResp = await _fetchCloud(`${url}/api/projects/${encodeURIComponent(project.name)}/changes`, { headers });
        if (!changesResp.ok) continue;
        const { changes } = await changesResp.json();
        if (changes.length > 0) {
          allChanges.push({ projectName: project.name, changes });
        }
      }
      if (allChanges.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cloud:pending-changes', { changes: allChanges });
      }
    }
  } catch (err) {
    console.warn('[Cloud] Failed to check pending changes on reconnect:', err.message);
  }
}

function setCloudMainWindow(win) {
  mainWindow = win;
}

module.exports = { registerCloudHandlers, setCloudMainWindow };
