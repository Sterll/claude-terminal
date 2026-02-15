/**
 * Shell Utilities
 * Cross-platform shell detection for PTY spawning
 */

/**
 * Get the appropriate shell for the current platform
 * @returns {{ path: string, args: string[] }}
 */
function getShell() {
  if (process.platform === 'win32') {
    return { path: 'cmd.exe', args: [] };
  }
  return { path: process.env.SHELL || '/bin/bash', args: [] };
}

/**
 * Get the shell prompt detection pattern
 * Used to detect when a shell is ready for input
 * @returns {string|RegExp}
 */
function getShellPromptPattern() {
  if (process.platform === 'win32') return '>';
  return /[$#%]\s*$/;
}

/**
 * Test if output matches the shell prompt pattern
 * @param {string} output
 * @returns {boolean}
 */
function matchesShellPrompt(output) {
  const pattern = getShellPromptPattern();
  if (typeof pattern === 'string') {
    return output.includes(pattern);
  }
  return pattern.test(output);
}

module.exports = { getShell, getShellPromptPattern, matchesShellPrompt };
