/**
 * ClaudeEventBus - Normalized event bus for Claude activity
 * Single source of truth for all Claude events regardless of provider (hooks or scraping).
 */

const EVENT_TYPES = {
  SESSION_START: 'session:start',
  SESSION_END: 'session:end',
  TOOL_START: 'tool:start',
  TOOL_END: 'tool:end',
  TOOL_ERROR: 'tool:error',
  PROMPT_SUBMIT: 'prompt:submit',
  CLAUDE_WORKING: 'claude:working',
  CLAUDE_DONE: 'claude:done',
  CLAUDE_PERMISSION: 'claude:permission',
  NOTIFICATION: 'notification',
  SUBAGENT_START: 'subagent:start',
  SUBAGENT_STOP: 'subagent:stop'
};

class ClaudeEventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event type. Use '*' for wildcard (all events).
   * @param {string} event - Event type or '*'
   * @param {Function} callback - Handler receiving normalized event envelope
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this._listeners.get(event)?.delete(callback);
  }

  /**
   * Emit a normalized event to all listeners.
   * @param {string} type - Event type from EVENT_TYPES
   * @param {Object} data - Event-specific data
   * @param {Object} meta - { projectId, projectPath, source }
   */
  emit(type, data = {}, meta = {}) {
    const envelope = {
      type,
      timestamp: Date.now(),
      projectId: meta.projectId || null,
      projectPath: meta.projectPath || null,
      source: meta.source || 'unknown',
      data
    };

    // Copy Sets before iterating — safe if a listener unsubscribes during emit
    const typeListeners = this._listeners.get(type);
    if (typeListeners) {
      for (const cb of [...typeListeners]) {
        try { cb(envelope); } catch (e) { console.error(`[EventBus] Error in ${type} listener:`, e); }
      }
    }

    const wildcardListeners = this._listeners.get('*');
    if (wildcardListeners) {
      for (const cb of [...wildcardListeners]) {
        try { cb(envelope); } catch (e) { console.error('[EventBus] Error in wildcard listener:', e); }
      }
    }
  }

  /**
   * Remove all listeners and reset state.
   */
  destroy() {
    this._listeners.clear();
  }
}

// Singleton instance
const eventBus = new ClaudeEventBus();

module.exports = { ClaudeEventBus, EVENT_TYPES, eventBus };
