/**
 * Git Utilities
 * Helper functions for git operations in the main process
 */

const { execFile, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Build safe.directory args array for git
 * @param {string} cwd - Working directory
 * @returns {string[]} - Args array ['-c', 'safe.directory=...']
 */
function safeDirArgs(cwd) {
  return ['-c', `safe.directory=${cwd.replace(/\\/g, '/')}`];
}

/**
 * Execute a git command in a specific directory using execFile (no shell injection)
 * @param {string} cwd - Working directory
 * @param {string|string[]} args - Git command arguments (string parsed by split, or array)
 * @param {number} timeout - Timeout in ms (default: 10000)
 * @returns {Promise<string|null>} - Command output or null on error
 */
function execGit(cwd, args, timeout = 10000) {
  return new Promise((resolve) => {
    const argsArray = Array.isArray(args) ? args : args.match(/(?:[^\s"]+|"[^"]*")+/g).map(a => a.replace(/^"|"$/g, ''));
    const fullArgs = [...safeDirArgs(cwd), ...argsArray];
    const child = execFile('git', fullArgs, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
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
 * Execute a git command returning { success, output, error } using execFile (no shell injection)
 * @param {string} cwd - Working directory
 * @param {string[]} args - Git command arguments as array
 * @param {Object} opts - Options (maxBuffer, timeout)
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
function spawnGit(cwd, args, opts = {}) {
  const { maxBuffer = 1024 * 1024, timeout = 15000 } = opts;
  return new Promise((resolve) => {
    const fullArgs = [...safeDirArgs(cwd), ...args];
    const child = execFile('git', fullArgs, { cwd, encoding: 'utf8', maxBuffer, timeout }, (error, stdout, stderr) => {
      if (timer) clearTimeout(timer);
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout || stderr || '' });
      }
    });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ success: false, error: 'Git command timed out' });
    }, timeout);

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ success: false, error: err.message });
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
async function checkoutBranch(projectPath, branch) {
  const result = await spawnGit(projectPath, ['checkout', branch]);
  if (!result.success) return result;
  return { success: true, output: result.output || `Switched to branch '${branch}'` };
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
  const result = await spawnGit(projectPath, ['status', '--porcelain']);
  if (!result.success) return { isGitRepo: false };
  const stdout = result.output;
  return {
    isGitRepo: true,
    hasChanges: stdout.trim().length > 0,
    changesCount: stdout.trim().split('\n').filter(l => l).length
  };
}

/**
 * Execute git pull
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Result object with success/error/conflicts
 */
async function gitPull(projectPath) {
  const result = await spawnGit(projectPath, ['pull', '--rebase']);
  if (!result.success) {
    const conflicts = await getMergeConflicts(projectPath);
    if (conflicts.length > 0) {
      return { success: false, hasConflicts: true, conflicts, error: 'Merge conflicts detected. Resolve conflicts or abort merge.' };
    }
    return result;
  }
  return { success: true, output: result.output || 'Already up to date.' };
}

/**
 * Execute git push
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Result object with success/error
 */
async function gitPush(projectPath) {
  const result = await spawnGit(projectPath, ['push']);
  if (!result.success) {
    if (result.error && result.error.includes('Everything up-to-date')) {
      return { success: true, output: 'Everything up-to-date.' };
    }
    return result;
  }
  return { success: true, output: result.output || 'Push successful.' };
}

/**
 * Execute git merge
 * @param {string} projectPath - Path to the project
 * @param {string} branch - Branch to merge into current branch
 * @returns {Promise<Object>} - Result object with success/error/conflicts
 */
async function gitMerge(projectPath, branch) {
  const result = await spawnGit(projectPath, ['merge', branch]);
  if (!result.success) {
    const conflicts = await getMergeConflicts(projectPath);
    if (conflicts.length > 0) {
      return { success: false, hasConflicts: true, conflicts, error: 'Merge conflicts detected. Resolve conflicts or abort merge.' };
    }
    return result;
  }
  return { success: true, output: result.output || 'Merge successful.' };
}

/**
 * Abort current merge
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Result object with success/error
 */
async function gitMergeAbort(projectPath) {
  const result = await spawnGit(projectPath, ['merge', '--abort']);
  if (!result.success) return result;
  return { success: true, output: 'Merge aborted.' };
}

/**
 * Continue merge after resolving conflicts
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Result object with success/error
 */
async function gitMergeContinue(projectPath) {
  const result = await spawnGit(projectPath, ['merge', '--continue']);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Merge completed.' };
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
  // Use git rev-parse to find the correct git dir (works for both regular repos and worktrees)
  const gitDir = await execGit(projectPath, 'rev-parse --git-dir');
  if (!gitDir) return false;
  const resolvedGitDir = path.resolve(projectPath, gitDir);
  const mergeHead = path.join(resolvedGitDir, 'MERGE_HEAD');
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

    const cloneProcess = execFile(
      'git',
      ['clone', '--progress', cloneUrl, targetPath],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10, timeout: 300000 }, // 5 min timeout
      (error, stdout, stderr) => {
        if (error) {
          // Check common errors
          if (stderr.includes('already exists')) {
            resolve({ success: false, error: 'Folder already exists' });
          } else if (stderr.includes('not found') || stderr.includes('Could not resolve')) {
            resolve({ success: false, error: 'Repository not found' });
          } else if (stderr.includes('Authentication failed') || stderr.includes('could not read Username')) {
            resolve({ success: false, error: 'Authentication failed. Connect to GitHub.' });
          } else {
            resolve({ success: false, error: stderr || error.message });
          }
        } else {
          resolve({ success: true, output: 'Clone successful', path: targetPath });
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
    const fullArgs = [...safeDirArgs(projectPath), 'ls-files'];
    execFile('git', fullArgs, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 * 50, timeout: 10000 }, (error, stdout) => {
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
async function gitStageFiles(projectPath, files) {
  if (!files || files.length === 0) return { success: false, error: 'No files specified' };
  const result = await spawnGit(projectPath, ['add', '--', ...files]);
  if (!result.success) return result;
  return { success: true, output: `Staged ${files.length} file(s)` };
}

/**
 * Create a commit
 * @param {string} projectPath - Path to the project
 * @param {string} message - Commit message
 * @returns {Promise<Object>} - Result object
 */
async function gitCommit(projectPath, message) {
  if (!message || !message.trim()) return { success: false, error: 'Commit message is required' };
  const result = await spawnGit(projectPath, ['commit', '-m', message]);
  if (!result.success) {
    if (result.error && result.error.includes('nothing to commit')) {
      return { success: false, error: 'Nothing to commit (no staged files)' };
    }
    return result;
  }
  return { success: true, output: result.output || 'Commit created' };
}

/**
 * Create a new branch and switch to it
 * @param {string} projectPath - Path to the project
 * @param {string} branchName - Name of the new branch
 * @returns {Promise<Object>} - Result object with success/error
 */
async function createBranch(projectPath, branchName) {
  const result = await spawnGit(projectPath, ['checkout', '-b', branchName]);
  if (!result.success) return result;
  return { success: true, output: result.output || `Switched to a new branch '${branchName}'` };
}

/**
 * Delete a local branch
 * @param {string} projectPath - Path to the project
 * @param {string} branch - Branch name to delete
 * @param {boolean} force - Use -D instead of -d (force delete unmerged branch)
 * @returns {Promise<Object>} - Result object with success/error
 */
async function deleteBranch(projectPath, branch, force = false) {
  const flag = force ? '-D' : '-d';
  const result = await spawnGit(projectPath, ['branch', flag, branch]);
  if (!result.success) return result;
  return { success: true, output: result.output || `Deleted branch ${branch}` };
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
async function cherryPick(projectPath, commitHash) {
  const result = await spawnGit(projectPath, ['cherry-pick', commitHash]);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Cherry-pick successful.' };
}

/**
 * Revert a commit
 * @param {string} projectPath - Path to the project
 * @param {string} commitHash - Commit hash to revert
 * @returns {Promise<Object>} - Result object
 */
async function revertCommit(projectPath, commitHash) {
  const result = await spawnGit(projectPath, ['revert', '--no-edit', commitHash]);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Revert successful.' };
}

/**
 * Unstage specific files
 * @param {string} projectPath - Path to the project
 * @param {string[]} files - List of file paths to unstage
 * @returns {Promise<Object>} - Result object
 */
async function gitUnstageFiles(projectPath, files) {
  if (!files || files.length === 0) return { success: false, error: 'No files specified' };
  const result = await spawnGit(projectPath, ['restore', '--staged', '--', ...files]);
  if (!result.success) return result;
  return { success: true, output: `Unstaged ${files.length} file(s)` };
}

/**
 * Apply a stash
 * @param {string} projectPath - Path to the project
 * @param {string} stashRef - Stash reference (e.g., stash@{0})
 * @returns {Promise<Object>} - Result object
 */
async function stashApply(projectPath, stashRef) {
  const result = await spawnGit(projectPath, ['stash', 'apply', stashRef]);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Stash applied.' };
}

/**
 * Drop a stash
 * @param {string} projectPath - Path to the project
 * @param {string} stashRef - Stash reference (e.g., stash@{0})
 * @returns {Promise<Object>} - Result object
 */
async function stashDrop(projectPath, stashRef) {
  const result = await spawnGit(projectPath, ['stash', 'drop', stashRef]);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Stash dropped.' };
}

/**
 * Save changes to a stash
 * @param {string} projectPath - Path to the project
 * @param {string} message - Optional stash message
 * @returns {Promise<Object>} - Result object
 */
async function gitStashSave(projectPath, message) {
  const args = (message && message.trim())
    ? ['stash', 'push', '-m', message.trim()]
    : ['stash'];
  const result = await spawnGit(projectPath, args);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Stash saved.' };
}

// ========== WORKTREES ==========

/**
 * Parse git worktree list --porcelain output
 * @param {string} output - Porcelain output from git worktree list
 * @returns {Array} - List of worktree objects
 */
function parseWorktreeListOutput(output) {
  if (!output) return [];

  const worktrees = [];
  let current = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice(9).trim() };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).trim().replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line.startsWith('locked')) {
      current.locked = true;
      const reason = line.slice(7).trim();
      if (reason) current.lockReason = reason;
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    } else if (line === '' && current.path) {
      worktrees.push(current);
      current = {};
    }
  }
  if (current.path) worktrees.push(current);

  // Mark the first entry as the main worktree
  if (worktrees.length > 0) worktrees[0].isMain = true;

  return worktrees;
}

/**
 * List all worktrees for a repository
 * @param {string} projectPath - Path to any worktree or the main repo
 * @returns {Promise<Array>} - List of worktree objects
 */
async function getWorktrees(projectPath) {
  const output = await execGit(projectPath, 'worktree list --porcelain');
  return parseWorktreeListOutput(output);
}

/**
 * Create a new worktree
 * @param {string} projectPath - Path to the main repo or existing worktree
 * @param {string} worktreePath - Path for the new worktree
 * @param {Object} options
 * @param {string} options.branch - Existing branch to check out
 * @param {string} options.newBranch - Name for a new branch to create
 * @param {string} options.startPoint - Start point for new branch (commit/branch)
 * @returns {Promise<Object>} - { success, error?, output? }
 */
function createWorktree(projectPath, worktreePath, options = {}) {
  return new Promise((resolve) => {
    const { branch, newBranch, startPoint } = options;
    let args = 'worktree add';

    if (newBranch) {
      args += ` -b "${newBranch}" "${worktreePath}"`;
      if (startPoint) args += ` "${startPoint}"`;
    } else if (branch) {
      args += ` "${worktreePath}" "${branch}"`;
    } else {
      args += ` "${worktreePath}"`;
    }

    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} ${args}`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stderr || stdout || 'Worktree created' });
      }
    });
  });
}

/**
 * Remove a worktree
 * @param {string} projectPath - Path to the main repo
 * @param {string} worktreePath - Path of the worktree to remove
 * @param {boolean} force - Force remove even if dirty
 * @returns {Promise<Object>}
 */
function removeWorktree(projectPath, worktreePath, force = false) {
  return new Promise((resolve) => {
    const forceFlag = force ? ' --force' : '';
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} worktree remove${forceFlag} "${worktreePath}"`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout || 'Worktree removed' });
      }
    });
  });
}

/**
 * Lock a worktree
 * @param {string} projectPath - Path to the main repo
 * @param {string} worktreePath - Path of the worktree to lock
 * @param {string} reason - Optional lock reason
 * @returns {Promise<Object>}
 */
function lockWorktree(projectPath, worktreePath, reason = '') {
  return new Promise((resolve) => {
    const reasonFlag = reason ? ` --reason "${reason.replace(/"/g, '\\"')}"` : '';
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} worktree lock${reasonFlag} "${worktreePath}"`, { cwd: projectPath, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: 'Worktree locked' });
      }
    });
  });
}

/**
 * Unlock a worktree
 * @param {string} projectPath - Path to the main repo
 * @param {string} worktreePath - Path of the worktree to unlock
 * @returns {Promise<Object>}
 */
function unlockWorktree(projectPath, worktreePath) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} worktree unlock "${worktreePath}"`, { cwd: projectPath, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: 'Worktree unlocked' });
      }
    });
  });
}

/**
 * Prune stale worktree entries
 * @param {string} projectPath - Path to the main repo
 * @returns {Promise<Object>}
 */
function pruneWorktrees(projectPath) {
  return new Promise((resolve) => {
    const safeDir = `-c safe.directory="${projectPath.replace(/\\/g, '/')}"`;
    exec(`git ${safeDir} worktree prune`, { cwd: projectPath, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: 'Worktrees pruned' });
      }
    });
  });
}

/**
 * Detect if a path is a worktree (not the main repo)
 * @param {string} projectPath - Path to check
 * @returns {Promise<Object>} - { isWorktree, mainRepoPath? }
 */
async function detectWorktree(projectPath) {
  const [gitDir, commonDir] = await Promise.all([
    execGit(projectPath, 'rev-parse --git-dir'),
    execGit(projectPath, 'rev-parse --git-common-dir')
  ]);

  if (!gitDir || !commonDir) return { isWorktree: false };

  const normGit = path.resolve(projectPath, gitDir).replace(/\\/g, '/');
  const normCommon = path.resolve(projectPath, commonDir).replace(/\\/g, '/');

  if (normGit !== normCommon) {
    const mainRepoPath = path.dirname(normCommon);
    return { isWorktree: true, mainRepoPath };
  }

  return { isWorktree: false };
}

/**
 * Get diff between two branches (for worktree comparison)
 * @param {string} projectPath - Path to any worktree of the repo
 * @param {string} branch1 - First branch name
 * @param {string} branch2 - Second branch name
 * @param {string} filePath - Optional specific file to diff
 * @returns {Promise<string>} - Diff output
 */
async function diffWorktreeBranches(projectPath, branch1, branch2, filePath = '') {
  const fileArg = filePath ? ` -- "${filePath}"` : '';
  const diff = await execGit(projectPath, `diff ${branch1}...${branch2}${fileArg}`, 15000);
  return diff || '';
}

module.exports = {
  parseGitStatus,
  parseDiffNumstat,
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
  gitStashSave,
  parseWorktreeListOutput,
  getWorktrees,
  createWorktree,
  removeWorktree,
  lockWorktree,
  unlockWorktree,
  pruneWorktrees,
  detectWorktree,
  diffWorktreeBranches
};
