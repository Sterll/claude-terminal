/**
 * The rotating placeholder in an empty composer.
 *
 * Reads the project rather than the conversation — uncommitted git changes
 * today — so it is a hint about where the project is, not about what was just
 * said. It writes only into the placeholder and only while the composer is
 * empty, so it can never touch something the user typed.
 */

const { t } = require('../../../i18n');

function createContextSuggestions(api, project, inputAdapter, getDefaultPlaceholder) {
  const CACHE_TTL = 30_000;
  const ROTATION_INTERVAL = 4_000;

  let suggestions = [];
  let currentIndex = 0;
  let rotationTimer = null;
  let cache = null; // { suggestions: string[], timestamp: number }
  let _refreshing = false;
  let _initTimer = null;
  let _postStreamTimer = null;

  function buildSuggestions(todos, gitStatus) {
    const result = [];
    const gitCount = gitStatus
      ? (gitStatus.modified?.length || 0) + (gitStatus.staged?.length || 0) + (gitStatus.untracked?.length || 0)
      : 0;
    if (gitCount > 0) result.push(t('chat.suggestGit', { count: gitCount }));
    return result;
  }

  async function refresh() {
    if (!project?.path || _refreshing) return;
    _refreshing = true;
    const now = Date.now();
    if (cache && now - cache.timestamp < CACHE_TTL) {
      suggestions = cache.suggestions;
      _refreshing = false;
      _start();
      return;
    }
    try {
      const [todos, gitStatus] = await Promise.all([
        api.project.scanTodos(project.path).catch(() => []),
        api.git.statusDetailed({ projectPath: project.path }).catch(() => null),
      ]);
      suggestions = buildSuggestions(todos, gitStatus);
      cache = { suggestions, timestamp: Date.now() };
    } catch {
      suggestions = [];
    } finally {
      _refreshing = false;
    }
    _start();
  }

  function _start() {
    stop();
    if (!suggestions.length) return;
    currentIndex = 0;
    _apply();
    if (suggestions.length > 1) {
      rotationTimer = setInterval(() => {
        if (!inputAdapter.isEmpty()) { stop(); return; }
        currentIndex = (currentIndex + 1) % suggestions.length;
        _apply();
      }, ROTATION_INTERVAL);
    }
  }

  function _apply() {
    // Don't overwrite if user has typed something
    if (!inputAdapter.isEmpty()) return;
    inputAdapter.setPlaceholder(suggestions[currentIndex] || getDefaultPlaceholder());
  }

  function stop() {
    if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; }
  }

  function reset() {
    stop();
    if (_initTimer) { clearTimeout(_initTimer); _initTimer = null; }
    if (_postStreamTimer) { clearTimeout(_postStreamTimer); _postStreamTimer = null; }
    _refreshing = false;
    suggestions = [];
    inputAdapter.setPlaceholder(getDefaultPlaceholder());
  }

  function handleTab(event) {
    if (!inputAdapter.isEmpty() || !suggestions.length) return false;
    event.preventDefault();
    // Strip the " [Tab]" hint from the raw i18n string and insert clean text
    const raw = suggestions[currentIndex] || '';
    const clean = raw.replace(/\s*\[Tab\]\s*$/, '');
    inputAdapter.setText(clean);
    reset();
    return true;
  }

  return { refresh, stop, reset, handleTab, setInitTimer(t) { _initTimer = t; }, setPostStreamTimer(t) { _postStreamTimer = t; } };
}

module.exports = { createContextSuggestions };
