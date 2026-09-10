/**
 * Project Type Extension Loader (renderer side)
 *
 * Asks the main process what is in `~/.claude-terminal/project-types/`, hands the
 * validated manifests to `registry.registerExternal()`, and tells the user about
 * anything that would not load.
 *
 * The whole path is off by default and this function is where that is cheapest to
 * enforce: with `projectTypeExtensionsEnabled` false it returns before the IPC
 * call, so a machine that has never opted in does not even look at the directory.
 * The main process re-checks the same setting — see
 * `design/project-type-extensions.md`, "Consent model" — because a renderer bug
 * must not be enough to turn the feature on.
 *
 * Nothing here can throw at the caller. It runs during boot, in sequence with
 * `registry.discoverAll()`, and a rejected promise at that point is a window that
 * never finishes rendering.
 */

const registry = require('../../project-types/registry');
const { getSetting } = require('../state/settings.state');
const { t } = require('../i18n');

/**
 * Human-readable, translated summary of one load failure.
 *
 * `reason` codes come from the shared validator and are stable; the strings live
 * in the five locale files under `projectTypes.problem.*`. An unknown code falls
 * back to the developer-facing `detail` rather than to an empty bubble.
 *
 * @param {{id: ?string, reason: string, detail: string}} problem
 * @returns {string}
 */
function describeProblem(problem) {
  const key = `projectTypes.problem.${problem.reason}`;
  const translated = t(key);
  const label = translated === key ? (problem.detail || problem.reason) : translated;
  return problem.id ? `${problem.id}: ${label}` : label;
}

/**
 * Discover, register and report extensions.
 *
 * @param {Object} [deps] - injected for tests
 * @param {Object} [deps.api] - defaults to window.electron_api
 * @param {Function} [deps.mergeTranslations] - i18n merge, passed through to the registry
 * @param {Object} [deps.toast] - { showWarning }
 * @returns {Promise<{skipped?: string, registered: string[], failed: Array, problems: Array}>}
 */
async function loadExtensions(deps = {}) {
  const empty = { registered: [], failed: [], problems: [] };

  try {
    if (getSetting('projectTypeExtensionsEnabled') !== true) {
      // Not merely "load nothing": do not even ask. The directory is not read,
      // not stat'd, and no IPC round-trip happens.
      registry.clearExternal();
      return { ...empty, skipped: 'disabled' };
    }

    const api = deps.api || (typeof window !== 'undefined' ? window.electron_api : null);
    if (!api || !api.projectTypes || typeof api.projectTypes.listExtensions !== 'function') {
      return { ...empty, skipped: 'no-bridge' };
    }

    const result = await api.projectTypes.listExtensions();
    const extensions = (result && Array.isArray(result.extensions)) ? result.extensions : [];
    const problems = (result && Array.isArray(result.problems)) ? result.problems : [];

    const { registered, failed } = registry.registerExternal(extensions, {
      mergeTranslations: deps.mergeTranslations,
    });

    // Problems are surfaced once, folded into a single toast. Someone with four
    // broken extensions in a folder has one problem, not four, and four stacked
    // toasts at startup is how a useful warning gets trained away.
    const all = [...problems, ...failed.map((f) => ({ id: f.id, reason: 'register-failed', detail: f.error }))];
    if (all.length) {
      const toast = deps.toast || require('../ui/components/Toast');
      if (toast && typeof toast.showWarning === 'function') {
        const shown = all.slice(0, 3).map(describeProblem).join('\n');
        const more = all.length > 3 ? `\n${t('projectTypes.problem.andMore', { count: all.length - 3 })}` : '';
        toast.showWarning(`${t('projectTypes.problem.title')}\n${shown}${more}`, 8000);
      }
    }

    return { registered, failed, problems };
  } catch (e) {
    // The loader failing must cost the user their extensions and nothing else.
    console.warn('[ProjectTypeExtensions] Load failed:', e && e.message);
    return { ...empty, skipped: 'error' };
  }
}

module.exports = { loadExtensions, describeProblem };
