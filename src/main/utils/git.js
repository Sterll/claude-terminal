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
    exec(`git ${args}`, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
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
 * Get list of local branches
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Array>} - List of branch names
 */
async function getBranches(projectPath) {
  const output = await execGit(projectPath, 'branch --format="%(refname:short)"');
  if (!output) return [];
  return output.split('\n').filter(b => b.trim());
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
    const { exec } = require('child_process');
    exec(`git checkout "${branch}"`, { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
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

  // Run all queries in parallel for speed
  const [
    lastCommitRaw,
    statusRaw,
    aheadBehind,
    branches,
    stashes,
    latestTag,
    recentCommits,
    contributors,
    totalCommits,
    remoteUrl
  ] = await Promise.all([
    execGit(projectPath, 'log -1 --format="%H|%s|%an|%ar"'),
    execGit(projectPath, 'status --porcelain'),
    getAheadBehind(projectPath, branch, skipFetch),
    getBranches(projectPath),
    getStashes(projectPath),
    getLatestTag(projectPath),
    getRecentCommits(projectPath, 5),
    getContributors(projectPath),
    getTotalCommits(projectPath),
    execGit(projectPath, 'remote get-url origin')
  ]);

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
    exec('git status --porcelain', { cwd: projectPath, encoding: 'utf8' }, (error, stdout) => {
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
 * @returns {Promise<Object>} - Result object with success/error
 */
function gitPull(projectPath) {
  return new Promise((resolve) => {
    exec('git pull', { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
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
    exec('git push', { cwd: projectPath, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
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
 * Count lines of code in a project
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Lines count by type
 */
async function countLinesOfCode(projectPath) {
  return new Promise((resolve) => {
    // Use git ls-files to only count tracked files, or fall back to all files
    const extensions = ['js', 'ts', 'jsx', 'tsx', 'vue', 'py', 'lua', 'css', 'scss', 'html', 'json', 'md', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'php', 'rb', 'swift', 'kt'];
    const extPattern = extensions.join(',');

    // Use PowerShell on Windows for reliable line counting
    const isWin = process.platform === 'win32';

    if (isWin) {
      const psCommand = `
        $extensions = @('.js', '.ts', '.jsx', '.tsx', '.vue', '.py', '.lua', '.css', '.scss', '.html', '.json', '.md', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.php', '.rb', '.swift', '.kt');
        $files = Get-ChildItem -Path "${projectPath.replace(/\\/g, '\\\\')}" -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $extensions -contains $_.Extension -and $_.FullName -notmatch 'node_modules|vendor|dist|build|\\.git' };
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

      exec(`powershell -NoProfile -Command "${psCommand}"`, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10, timeout: 15000 }, (error, stdout) => {
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
      // Unix: use find + wc
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

module.exports = {
  execGit,
  getGitInfo,
  getGitInfoFull,
  getGitStatusQuick,
  gitPull,
  gitPush,
  countLinesOfCode,
  getProjectStats,
  getBranches,
  getCurrentBranch,
  checkoutBranch
};
