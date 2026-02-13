/**
 * Git Utilities
 * Helper functions for git operations in the main process
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Execute a git command in a specific directory
 * @param {string} cwd - Working directory
 * @param {string} args - Git command arguments
 * @param {number} timeout - Timeout in ms (default: 10000)
 * @returns {Promise<string|null>} - Command output or null on error
 */
function execGit(cwd, args, timeout = 10000) {
  return new Promise((resolve) => {
    // Add safe.directory config to handle "dubious ownership" errors on Windows
    // This occurs when the repo is owned by a different user
    const safeDirectoryConfig = `-c safe.directory="${cwd.replace(/\\/g, '/')}"`;
    const child = exec(`git ${safeDirectoryConfig} ${args}`, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (timer) clearTimeout(timer);
      resolve(error ? null : stdout.trimEnd());
    });

    // Manual timeout with explicit kill (exec timeout doesn't kill the process)
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve(null);
    }, timeout);

    child.on('error', () => {
      if (timer) clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Parse git status porcelain output into categorized files
 * @param {string} status - Git status --porcelain output
 * @returns {Object} - Categorized files
 */
function parseGitStatus(status) {
  const files = {
    staged: [],
    unstaged: [],
    untracked: [],
    all: []
  };

  if (!status) return files;

  status.split('\n').forEach(line => {
    if (!line.trim()) return;

    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const filePath = line.slice(3);

    let type = 'modified';
    let category = 'unstaged';

    // Staged changes (index)
    if (indexStatus !== ' ' && indexStatus !== '?') {
      if (indexStatus === 'A') type = 'added';
      else if (indexStatus === 'D') type = 'deleted';
      else if (indexStatus === 'R') type = 'renamed';
      else if (indexStatus === 'M') type = 'modified';
      files.staged.push({ type, file: filePath });
    }

    // Unstaged changes (work tree)
    if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
      if (workTreeStatus === 'D') type = 'deleted';
      else type = 'modified';
      files.unstaged.push({ type, file: filePath });
    }

    // Untracked files
    if (indexStatus === '?' && workTreeStatus === '?') {
      files.untracked.push({ type: 'untracked', file: filePath });
    }

    // All files for backwards compatibility
    files.all.push({ type, file: filePath });
  });

  return files;
}

/**
 * Get ahead/behind status relative to remote
 * @param {string} projectPath - Path to the project
 * @param {string} branch - Current branch name
 * @param {boolean} skipFetch - Skip fetching from remote (faster, uses local data)
 * @returns {Promise<Object>} - { ahead, behind, remote }
 */
async function getAheadBehind(projectPath, branch, skipFetch = false) {
  // Try to fetch with a short timeout (3s) - don't block if network is slow/offline
  if (!skipFetch) {
    await execGit(projectPath, 'fetch --quiet', 3000).catch(() => {});
  }

  // Get the upstream tracking branch
  const upstream = await execGit(projectPath, `rev-parse --abbrev-ref ${branch}@{upstream}`);
  if (!upstream) {
    // No upstream set, check if remote origin exists
    const remoteUrl = await execGit(projectPath, 'remote get-url origin');
    if (remoteUrl) {
      // Remote exists but branch is not tracking - still has remote
      return { ahead: 0, behind: 0, remote: null, hasRemote: true, notTracking: true };
    }
    return { ahead: 0, behind: 0, remote: null, hasRemote: false };
  }

  // Get ahead/behind counts
  const counts = await execGit(projectPath, `rev-list --left-right --count ${branch}...${upstream}`);
  if (!counts) {
    return { ahead: 0, behind: 0, remote: upstream, hasRemote: true };
  }

  const [ahead, behind] = counts.split('\t').map(n => parseInt(n, 10) || 0);
  return { ahead, behind, remote: upstream, hasRemote: true };
}

/**
 * Get list of all branches (local and remote)
 * @param {string} projectPath - Path to the project
 * @param {Object} options
 * @param {boolean} options.skipFetch - Skip fetching from remote (default: true)
 * @returns {Promise<Object>} - Object with local and remote branch arrays
 */
async function getBranches(projectPath, options = {}) {
  const { skipFetch = true } = options;

  // Get local branches
  const localOutput = await execGit(projectPath, 'branch --format="%(refname:short)"');
  const local = localOutput ? localOutput.split('\n').filter(b => b.trim()) : [];

  // Only fetch if explicitly requested (avoids network blocking on dashboard load)
  if (!skipFetch) {
    await execGit(projectPath, 'fetch --all --prune', 5000).catch(() => {});
  }
  const remoteOutput = await execGit(projectPath, 'branch -r --format="%(refname:short)"');
  const remote = remoteOutput
    ? remoteOutput.split('\n')
        .filter(b => b.trim())
        .filter(b => !b.includes('HEAD')) // Exclude HEAD pointer
        .map(b => b.replace(/^origin\//, '')) // Remove origin/ prefix for display
        .filter(b => !local.includes(b)) // Exclude branches already in local
    : [];

  return { local, remote };
}

/**
 * Get current branch name
 * @param {string} projectPath - Path to the project
 * @returns {Promise<string|null>} - Current branch name or null
 */
async function getCurrentBranch(projectPath) {
  const branch = await execGit(projectPath, 'rev-parse --abbrev-ref HEAD');
  return branch || null;
}

/**
 * Checkout a branch
 * @param {string} projectPath - Path to the project
 * @param {string} branch - Branch name to checkout
 * @returns {Promise<Object>} - Result object with success/error
 */
function checkoutBranch(projectPath, branch) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} checkout "${branch}"`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stderr || stdout || `Switched to branch '${branch}'` });
      }
    });
  });
}

/**
 * Get list of stashes
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Array>} - List of stash entries
 */
async function getStashes(projectPath) {
  const output = await execGit(projectPath, 'stash list --format="%gd|%s|%ar"');
  if (!output) return [];
  return output.split('\n').filter(l => l.trim()).map(line => {
    const [ref, message, date] = line.split('|');
    return { ref, message, date };
  });
}

/**
 * Get latest tag
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object|null>} - Tag info or null
 */
async function getLatestTag(projectPath) {
  const tag = await execGit(projectPath, 'describe --tags --abbrev=0');
  if (!tag) return null;

  const tagDate = await execGit(projectPath, `log -1 --format="%ar" ${tag}`);
  const commitsBehind = await execGit(projectPath, `rev-list ${tag}..HEAD --count`);

  return {
    name: tag,
    date: tagDate,
    commitsBehind: parseInt(commitsBehind, 10) || 0
  };
}

/**
 * Get recent commits
 * @param {string} projectPath - Path to the project
 * @param {number} count - Number of commits to get
 * @returns {Promise<Array>} - List of commits
 */
async function getRecentCommits(projectPath, count = 5) {
  const output = await execGit(projectPath, `log -${count} --format="%h|%s|%an|%ar"`);
  if (!output) return [];
  return output.split('\n').filter(l => l.trim()).map(line => {
    const [hash, message, author, date] = line.split('|');
    return { hash, message, author, date };
  });
}

/**
 * Get contributors stats
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Array>} - List of contributors
 */
async function getContributors(projectPath) {
  // Use a 5s timeout - shortlog can be slow on large repos
  const output = await execGit(projectPath, 'shortlog -sn --all --no-merges', 5000);
  if (!output) return [];
  return output.split('\n').filter(l => l.trim()).slice(0, 5).map(line => {
    const match = line.trim().match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return null;
    return { commits: parseInt(match[1], 10), name: match[2] };
  }).filter(Boolean);
}

/**
 * Get total commit count
 * @param {string} projectPath - Path to the project
 * @returns {Promise<number>} - Total commits
 */
async function getTotalCommits(projectPath) {
  const count = await execGit(projectPath, 'rev-list --count HEAD');
  return parseInt(count, 10) || 0;
}

/**
 * Get git info for a project (branch, last commit, changed files)
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Git info object
 */
async function getGitInfo(projectPath) {
  const branch = await execGit(projectPath, 'rev-parse --abbrev-ref HEAD');
  if (!branch) return { isGitRepo: false };

  const lastCommit = await execGit(projectPath, 'log -1 --format="%H|%s|%an|%ar"');
  const status = await execGit(projectPath, 'status --porcelain');

  let commit = null;
  if (lastCommit) {
    const [hash, message, author, date] = lastCommit.split('|');
    commit = { hash: hash?.slice(0, 7), message, author, date };
  }

  const files = parseGitStatus(status);

  return { isGitRepo: true, branch, commit, files: files.all };
}

/**
 * Get comprehensive git info for dashboard
 * @param {string} projectPath - Path to the project
 * @param {Object} options - Options
 * @param {boolean} options.skipFetch - Skip fetching from remote (default: true for speed)
 * @returns {Promise<Object>} - Complete git info
 */
async function getGitInfoFull(projectPath, options = {}) {
  const { skipFetch = true } = options;

  const branch = await execGit(projectPath, 'rev-parse --abbrev-ref HEAD');
  if (!branch) return { isGitRepo: false };

  // Batch 1: Fast local queries (index only, no network)
  const [
    lastCommitRaw,
    statusRaw,
    remoteUrl,
    totalCommits
  ] = (await Promise.allSettled([
    execGit(projectPath, 'log -1 --format="%H|%s|%an|%ar"'),
    execGit(projectPath, 'status --porcelain'),
    execGit(projectPath, 'remote get-url origin'),
    getTotalCommits(projectPath)
  ])).map(r => r.status === 'fulfilled' ? r.value : null);

  // Batch 2: Heavier queries (may involve refs traversal, but still local)
  const [
    aheadBehind,
    branches,
    recentCommits,
    stashes,
    latestTag,
    contributors
  ] = (await Promise.allSettled([
    getAheadBehind(projectPath, branch, skipFetch),
    getBranches(projectPath),
    getRecentCommits(projectPath, 5),
    getStashes(projectPath),
    getLatestTag(projectPath),
    getContributors(projectPath)
  ])).map(r => r.status === 'fulfilled' ? r.value : null);

  let commit = null;
  if (lastCommitRaw) {
    const [hash, message, author, date] = lastCommitRaw.split('|');
    commit = { hash: hash?.slice(0, 7), fullHash: hash, message, author, date };
  }

  const files = parseGitStatus(statusRaw);

  return {
    isGitRepo: true,
    branch,
    commit,
    files,
    aheadBehind,
    branches,
    stashes,
    latestTag,
    recentCommits,
    contributors,
    totalCommits,
    remoteUrl: remoteUrl || null
  };
}

/**
 * Quick git status check
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Status object
 */
async function getGitStatusQuick(projectPath) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} status --porcelain`, { cwd: projectPath, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        resolve({ isGitRepo: false });
      } else {
        const hasChanges = stdout.trim().length > 0;
        resolve({
          isGitRepo: true,
          hasChanges,
          changesCount: stdout.trim().split('\n').filter(l => l).length
        });
      }
    });
  });
}

/**
 * Execute git pull
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Result object with success/error/conflicts
 */
function gitPull(projectPath) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} pull --rebase`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, async (error, stdout, stderr) => {
      if (error) {
        // Check if there are merge conflicts
        const conflicts = await getMergeConflicts(projectPath);
        if (conflicts.length > 0) {
          resolve({
            success: false,
            hasConflicts: true,
            conflicts,
            error: 'Merge conflicts detected. Resolve conflicts or abort merge.'
          });
        } else {
          resolve({ success: false, error: stderr || error.message });
        }
      } else {
        resolve({ success: true, output: stdout || 'Already up to date.' });
      }
    });
  });
}

/**
 * Execute git push
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Result object with success/error
 */
function gitPush(projectPath) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} push`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // Check if it's just a "nothing to push" situation
        if (stderr && stderr.includes('Everything up-to-date')) {
          resolve({ success: true, output: 'Everything up-to-date.' });
        } else {
          resolve({ success: false, error: stderr || error.message });
        }
      } else {
        resolve({ success: true, output: stdout || stderr || 'Push successful.' });
      }
    });
  });
}

/**
 * Execute git merge
 * @param {string} projectPath - Path to the project
 * @param {string} branch - Branch to merge into current branch
 * @returns {Promise<Object>} - Result object with success/error/conflicts
 */
function gitMerge(projectPath, branch) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} merge "${branch}"`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, async (error, stdout, stderr) => {
      if (error) {
        // Check if there are merge conflicts
        const conflicts = await getMergeConflicts(projectPath);
        if (conflicts.length > 0) {
          resolve({
            success: false,
            hasConflicts: true,
            conflicts,
            error: 'Merge conflicts detected. Resolve conflicts or abort merge.'
          });
        } else {
          resolve({ success: false, error: stderr || error.message });
        }
      } else {
        resolve({ success: true, output: stdout || 'Merge successful.' });
      }
    });
  });
}

/**
 * Abort current merge
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Result object with success/error
 */
function gitMergeAbort(projectPath) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} merge --abort`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: 'Merge aborted.' });
      }
    });
  });
}

/**
 * Continue merge after resolving conflicts
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Result object with success/error
 */
function gitMergeContinue(projectPath) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} merge --continue`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout || 'Merge completed.' });
      }
    });
  });
}

/**
 * Get list of files with merge conflicts
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Array>} - List of conflicted files
 */
async function getMergeConflicts(projectPath) {
  const output = await execGit(projectPath, 'diff --name-only --diff-filter=U');
  if (!output) return [];
  return output.split('\n').filter(f => f.trim());
}

/**
 * Check if there's a merge in progress
 * @param {string} projectPath - Path to the project
 * @returns {Promise<boolean>} - True if merge in progress
 */
async function isMergeInProgress(projectPath) {
  const mergeHead = path.join(projectPath, '.git', 'MERGE_HEAD');
  return fs.existsSync(mergeHead);
}

/**
 * Clone a git repository
 * @param {string} repoUrl - URL of the repository to clone
 * @param {string} targetPath - Path where to clone the repo
 * @param {Object} options - Optional settings
 * @param {string} options.token - GitHub token for private repos
 * @param {Function} options.onProgress - Callback for progress updates
 * @returns {Promise<Object>} - Result object with success/error
 */
function gitClone(repoUrl, targetPath, options = {}) {
  return new Promise((resolve) => {
    const { token, onProgress } = options;

    // Ensure target directory exists
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Inject token into HTTPS URL if provided
    let cloneUrl = repoUrl;
    if (token && repoUrl.startsWith('https://github.com/')) {
      cloneUrl = repoUrl.replace('https://github.com/', `https://${token}@github.com/`);
    } else if (token && repoUrl.startsWith('https://')) {
      // Generic HTTPS URL with token
      cloneUrl = repoUrl.replace('https://', `https://${token}@`);
    }

    const cloneProcess = exec(
      `git clone --progress "${cloneUrl}" "${targetPath}"`,
      { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10, timeout: 300000 }, // 5 min timeout
      (error, stdout, stderr) => {
        if (error) {
          // Check common errors
          if (stderr.includes('already exists')) {
            resolve({ success: false, error: 'Le dossier existe déjà' });
          } else if (stderr.includes('not found') || stderr.includes('Could not resolve')) {
            resolve({ success: false, error: 'Repository introuvable' });
          } else if (stderr.includes('Authentication failed') || stderr.includes('could not read Username')) {
            resolve({ success: false, error: 'Authentification échouée. Connectez-vous à GitHub.' });
          } else {
            resolve({ success: false, error: stderr || error.message });
          }
        } else {
          resolve({ success: true, output: 'Clone réussi', path: targetPath });
        }
      }
    );

    // Handle progress if callback provided
    if (onProgress && cloneProcess.stderr) {
      cloneProcess.stderr.on('data', (data) => {
        onProgress(data.toString());
      });
    }
  });
}

/**
 * Count lines of code in a project
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Lines count by type
 */
async function countLinesOfCode(projectPath) {
  const extensions = ['.js', '.ts', '.jsx', '.tsx', '.vue', '.py', '.lua', '.css', '.scss', '.html', '.json', '.md', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.php', '.rb', '.swift', '.kt'];

  // Try git ls-files first (fast, reads from index)
  const gitResult = await new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} ls-files`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 * 50, timeout: 10000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(null);
        return;
      }
      resolve(stdout.trim().split('\n').filter(f => f.trim()));
    });
  });

  if (gitResult && gitResult.length > 0) {
    return countLinesFromFileList(projectPath, gitResult, extensions);
  }

  // Fallback: filesystem scan for non-git projects
  return countLinesFromFilesystem(projectPath, extensions);
}

async function countLinesFromFileList(projectPath, fileList, extensions) {
  const path = require('path');
  const fs = require('fs').promises;

  // Filter files by extension
  const sourceFiles = fileList.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return extensions.includes(ext);
  });

  let totalLines = 0;
  let totalFiles = 0;
  const byExtension = {};

  // Process files in batches of 50 to avoid blocking
  const BATCH_SIZE = 50;
  for (let i = 0; i < sourceFiles.length; i += BATCH_SIZE) {
    const batch = sourceFiles.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async (relPath) => {
      const fullPath = path.join(projectPath, relPath);
      const content = await fs.readFile(fullPath, 'utf8');
      return { relPath, lines: content.split('\n').length };
    }));

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { relPath, lines } = result.value;
      totalLines += lines;
      totalFiles++;

      const ext = path.extname(relPath).toLowerCase();
      if (!byExtension[ext]) byExtension[ext] = { files: 0, lines: 0 };
      byExtension[ext].files++;
      byExtension[ext].lines += lines;
    }
  }

  return { total: totalLines, files: totalFiles, byExtension };
}

async function countLinesFromFilesystem(projectPath, extensions) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';

    if (isWin) {
      const extList = extensions.map(e => `'${e}'`).join(', ');
      const psCommand = `
        $extensions = @(${extList});
        $files = Get-ChildItem -Path "${projectPath.replace(/\\/g, '\\\\')}" -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $extensions -contains $_.Extension -and $_.FullName -notmatch 'node_modules|vendor|dist|build|cache|stream|\\.git' };
        $totalLines = 0;
        $totalFiles = 0;
        $byExt = @{};
        foreach ($file in $files) {
          try {
            $lines = (Get-Content $file.FullName -ErrorAction SilentlyContinue | Measure-Object -Line).Lines;
            $totalLines += $lines;
            $totalFiles++;
            $ext = $file.Extension;
            if (-not $byExt.ContainsKey($ext)) { $byExt[$ext] = @{files=0;lines=0} };
            $byExt[$ext].files++;
            $byExt[$ext].lines += $lines;
          } catch {}
        }
        $result = @{total=$totalLines;files=$totalFiles;byExtension=@{}};
        foreach ($key in $byExt.Keys) { $result.byExtension[$key] = $byExt[$key] };
        $result | ConvertTo-Json -Compress
      `.replace(/\n/g, ' ');

      exec(`powershell -NoProfile -Command "${psCommand}"`, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10, timeout: 30000 }, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve({ total: 0, files: 0, byExtension: {} });
          return;
        }
        try {
          const result = JSON.parse(stdout.trim());
          resolve({
            total: result.total || 0,
            files: result.files || 0,
            byExtension: result.byExtension || {}
          });
        } catch (e) {
          resolve({ total: 0, files: 0, byExtension: {} });
        }
      });
    } else {
      const cmd = `find "${projectPath}" -type f \\( -name "*.js" -o -name "*.ts" -o -name "*.jsx" -o -name "*.tsx" -o -name "*.vue" -o -name "*.py" -o -name "*.lua" -o -name "*.css" -o -name "*.scss" -o -name "*.html" -o -name "*.go" -o -name "*.rs" -o -name "*.java" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/vendor/*" | head -1000 | xargs wc -l 2>/dev/null | tail -1`;

      exec(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10, timeout: 15000 }, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve({ total: 0, files: 0, byExtension: {} });
          return;
        }
        const match = stdout.trim().match(/(\d+)/);
        resolve({
          total: match ? parseInt(match[1], 10) : 0,
          files: 0,
          byExtension: {}
        });
      });
    }
  });
}

/**
 * Get project statistics (file count, size, etc.)
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Project stats
 */
async function getProjectStats(projectPath) {
  const linesData = await countLinesOfCode(projectPath);

  return {
    lines: linesData.total,
    files: linesData.files,
    byExtension: linesData.byExtension
  };
}

/**
 * Parse git diff --numstat output into a Map of filePath -> { additions, deletions }
 * @param {string|null} output - Raw numstat output
 * @returns {Map<string, {additions: number, deletions: number}>}
 */
function parseDiffNumstat(output) {
  const map = new Map();
  if (!output) return map;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (match) {
      map.set(match[3], {
        additions: match[1] === '-' ? 0 : parseInt(match[1], 10) || 0,
        deletions: match[2] === '-' ? 0 : parseInt(match[2], 10) || 0
      });
    }
  }
  return map;
}

/**
 * Get detailed git status with file additions/deletions
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Detailed status with files
 */
async function getGitStatusDetailed(projectPath) {
  try {
    // Get status + all diff stats in parallel (3 commands instead of N*2)
    const [statusOutput, allDiffRaw, allStagedRaw] = await Promise.all([
      execGit(projectPath, 'status --porcelain'),
      execGit(projectPath, 'diff --numstat'),
      execGit(projectPath, 'diff --cached --numstat')
    ]);

    if (statusOutput === null) {
      return { success: false, error: 'Not a git repository' };
    }

    const diffMap = parseDiffNumstat(allDiffRaw);
    const stagedMap = parseDiffNumstat(allStagedRaw);
    const files = [];

    if (statusOutput.trim()) {
      const lines = statusOutput.split('\n').filter(l => l.trim());

      for (const line of lines) {
        const indexStatus = line[0];
        const workTreeStatus = line[1];
        const filePath = line.slice(3);

        // Determine the status code to show
        let status = 'M';
        if (indexStatus === '?' || workTreeStatus === '?') status = '?';
        else if (indexStatus === 'A' || workTreeStatus === 'A') status = 'A';
        else if (indexStatus === 'D' || workTreeStatus === 'D') status = 'D';
        else if (indexStatus === 'R' || workTreeStatus === 'R') status = 'R';
        else if (indexStatus === 'M' || workTreeStatus === 'M') status = 'M';

        // Lookup diff stats from pre-fetched maps (O(1) per file)
        const diff = diffMap.get(filePath) || { additions: 0, deletions: 0 };
        const staged = stagedMap.get(filePath) || { additions: 0, deletions: 0 };
        const additions = diff.additions + staged.additions;
        const deletions = diff.deletions + staged.deletions;

        files.push({
          path: filePath,
          status,
          staged: indexStatus !== ' ' && indexStatus !== '?',
          additions,
          deletions
        });
      }
    }

    return { success: true, files };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Stage specific files
 * @param {string} projectPath - Path to the project
 * @param {string[]} files - List of file paths to stage
 * @returns {Promise<Object>} - Result object
 */
function gitStageFiles(projectPath, files) {
  return new Promise((resolve) => {
    if (!files || files.length === 0) {
      resolve({ success: false, error: 'No files specified' });
      return;
    }

    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    const fileArgs = files.map(f => `"${f}"`).join(' ');

    exec(`git ${safeDir} add ${fileArgs}`, { cwd: projectPath, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: `Staged ${files.length} file(s)` });
      }
    });
  });
}

/**
 * Create a commit
 * @param {string} projectPath - Path to the project
 * @param {string} message - Commit message
 * @returns {Promise<Object>} - Result object
 */
function gitCommit(projectPath, message) {
  return new Promise((resolve) => {
    if (!message || !message.trim()) {
      resolve({ success: false, error: 'Commit message is required' });
      return;
    }

    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    // Escape the message for shell
    const escapedMessage = message.replace(/"/g, '\\"');

    exec(`git ${safeDir} commit -m "${escapedMessage}"`, { cwd: projectPath, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        // Check if it's just "nothing to commit"
        if (stderr && stderr.includes('nothing to commit')) {
          resolve({ success: false, error: 'Nothing to commit (no staged files)' });
        } else {
          resolve({ success: false, error: stderr || error.message });
        }
      } else {
        resolve({ success: true, output: stdout || 'Commit created' });
      }
    });
  });
}

/**
 * Create a new branch and switch to it
 * @param {string} projectPath - Path to the project
 * @param {string} branchName - Name of the new branch
 * @returns {Promise<Object>} - Result object with success/error
 */
function createBranch(projectPath, branchName) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} checkout -b "${branchName}"`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stderr || stdout || `Switched to a new branch '${branchName}'` });
      }
    });
  });
}

/**
 * Delete a local branch
 * @param {string} projectPath - Path to the project
 * @param {string} branch - Branch name to delete
 * @param {boolean} force - Use -D instead of -d (force delete unmerged branch)
 * @returns {Promise<Object>} - Result object with success/error
 */
function deleteBranch(projectPath, branch, force = false) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    const flag = force ? '-D' : '-d';
    exec(`git ${safeDir} branch ${flag} "${branch}"`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout || `Deleted branch ${branch}` });
      }
    });
  });
}

/**
 * Get paginated commit history
 * @param {string} projectPath - Path to the project
 * @param {Object} options - Options
 * @param {number} options.skip - Number of commits to skip
 * @param {number} options.limit - Number of commits to return
 * @param {string} options.branch - Branch to get history for (optional)
 * @param {boolean} options.allBranches - Show commits from all branches
 * @returns {Promise<Array>} - List of commits
 */
async function getCommitHistory(projectPath, { skip = 0, limit = 30, branch = '', allBranches = false } = {}) {
  const RS = '%x1e'; // Record Separator to avoid conflicts with commit messages
  const format = `%H${RS}%h${RS}%s${RS}%an${RS}%ae${RS}%ar${RS}%aI${RS}%P${RS}%D`;
  const allFlag = allBranches ? ' --all' : '';
  const branchArg = branch ? ` ${branch}` : '';
  const output = await execGit(projectPath, `log --skip=${skip} -${limit} --format="${format}"${allFlag}${branchArg}`, 15000);
  if (!output) return [];
  return output.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.split('\x1e');
    const [fullHash, hash, message, author, email, date, isoDate, parentStr, decorations] = parts;
    const parents = parentStr ? parentStr.trim().split(' ').filter(Boolean) : [];
    return { fullHash, hash, message, author, email, date, isoDate, parents, decorations: decorations || '' };
  });
}

/**
 * Get diff for a specific file
 * @param {string} projectPath - Path to the project
 * @param {string} filePath - File path
 * @param {boolean} staged - Whether to get staged diff
 * @returns {Promise<string>} - Raw diff output
 */
async function getFileDiff(projectPath, filePath, staged = false) {
  const stagedFlag = staged ? '--cached ' : '';
  const diff = await execGit(projectPath, `diff ${stagedFlag}-- "${filePath}"`, 10000);
  return diff || '';
}

/**
 * Get commit detail (show --stat)
 * @param {string} projectPath - Path to the project
 * @param {string} commitHash - Commit hash
 * @returns {Promise<string>} - Commit detail output
 */
async function getCommitDetail(projectPath, commitHash) {
  const output = await execGit(projectPath, `show --stat --format="commit %H%nAuthor: %an <%ae>%nDate:   %aI%n%n    %s%n%n    %b" ${commitHash}`, 10000);
  return output || '';
}

/**
 * Cherry-pick a commit
 * @param {string} projectPath - Path to the project
 * @param {string} commitHash - Commit hash to cherry-pick
 * @returns {Promise<Object>} - Result object
 */
function cherryPick(projectPath, commitHash) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} cherry-pick ${commitHash}`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout || 'Cherry-pick successful.' });
      }
    });
  });
}

/**
 * Revert a commit
 * @param {string} projectPath - Path to the project
 * @param {string} commitHash - Commit hash to revert
 * @returns {Promise<Object>} - Result object
 */
function revertCommit(projectPath, commitHash) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} revert --no-edit ${commitHash}`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout || 'Revert successful.' });
      }
    });
  });
}

/**
 * Unstage specific files
 * @param {string} projectPath - Path to the project
 * @param {string[]} files - List of file paths to unstage
 * @returns {Promise<Object>} - Result object
 */
function gitUnstageFiles(projectPath, files) {
  return new Promise((resolve) => {
    if (!files || files.length === 0) {
      resolve({ success: false, error: 'No files specified' });
      return;
    }
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    const fileArgs = files.map(f => `"${f}"`).join(' ');
    exec(`git ${safeDir} restore --staged ${fileArgs}`, { cwd: projectPath, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: `Unstaged ${files.length} file(s)` });
      }
    });
  });
}

/**
 * Apply a stash
 * @param {string} projectPath - Path to the project
 * @param {string} stashRef - Stash reference (e.g., stash@{0})
 * @returns {Promise<Object>} - Result object
 */
function stashApply(projectPath, stashRef) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} stash apply "${stashRef}"`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout || 'Stash applied.' });
      }
    });
  });
}

/**
 * Drop a stash
 * @param {string} projectPath - Path to the project
 * @param {string} stashRef - Stash reference (e.g., stash@{0})
 * @returns {Promise<Object>} - Result object
 */
function stashDrop(projectPath, stashRef) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} stash drop "${stashRef}"`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout || 'Stash dropped.' });
      }
    });
  });
}

/**
 * Save changes to a stash
 * @param {string} projectPath - Path to the project
 * @param {string} message - Optional stash message
 * @returns {Promise<Object>} - Result object
 */
function gitStashSave(projectPath, message) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    const cmd = message && message.trim()
      ? `git ${safeDir} stash push -m "${message.trim().replace(/"/g, '\\"')}"`
      : `git ${safeDir} stash`;
    exec(cmd, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout || 'Stash saved.' });
      }
    });
  });
}

module.exports = {
  execGit,
  getGitInfo,
  getGitInfoFull,
  getGitStatusQuick,
  getGitStatusDetailed,
  gitPull,
  gitPush,
  gitMerge,
  gitMergeAbort,
  gitMergeContinue,
  getMergeConflicts,
  isMergeInProgress,
  gitClone,
  gitStageFiles,
  gitCommit,
  countLinesOfCode,
  getProjectStats,
  getBranches,
  getCurrentBranch,
  checkoutBranch,
  createBranch,
  deleteBranch,
  getCommitHistory,
  getFileDiff,
  getCommitDetail,
  cherryPick,
  revertCommit,
  gitUnstageFiles,
  stashApply,
  stashDrop,
  gitStashSave
};
