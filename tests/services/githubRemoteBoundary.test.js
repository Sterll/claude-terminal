/** @jest-environment node */
jest.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
jest.mock('keytar', () => ({}));
const { parseGitHubRemote, configure } = require('../../src/main/services/GitHubAuthService');
afterEach(() => configure({ githubHostname: 'github.com' }));
test('GitHub token eligibility requires the exact configured host', () => {
  for (const value of ['https://evil-github.com/a/b', 'https://evil.test/github.com/a/b', 'https://github.com@evil.test/a/b', 'git@evil-github.com:a/b', 'https://github.com:8443/a/b']) expect(parseGitHubRemote(value)).toBeNull();
  expect(parseGitHubRemote('https://github.com/owner/repo.with.dots.git')).toEqual({ owner: 'owner', repo: 'repo.with.dots' });
  expect(parseGitHubRemote('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  configure({ githubHostname: 'git.example.test:8443' });
  expect(parseGitHubRemote('https://git.example.test:8443/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  expect(parseGitHubRemote('https://github.com/owner/repo.git')).toBeNull();
});
