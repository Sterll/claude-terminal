/**
 * Discord Renderer - Orchestrator
 * Central module that coordinates embed, component, and message rendering
 */

const EmbedRenderer = require('./EmbedRenderer');
const ComponentRenderer = require('./ComponentRenderer');
const MessageRenderer = require('./MessageRenderer');

/**
 * Render a Discord embed from data or code
 * @param {Object|string} input - Embed JSON object or builder code string
 * @returns {string} HTML string
 */
function renderEmbed(input) {
  if (!input) return '';

  if (typeof input === 'string') {
    // Try JSON parse first
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') {
        return EmbedRenderer.render(parsed);
      }
    } catch {
      // Try parsing builder code
      const parsed = EmbedRenderer.parseEmbedFromCode(input);
      if (parsed) return EmbedRenderer.render(parsed);
    }
    return '';
  }

  return EmbedRenderer.render(input);
}

/**
 * Render Discord components from data
 * @param {Object[]|string} input - Components array or JSON string
 * @returns {string} HTML string
 */
function renderComponents(input) {
  if (!input) return '';

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) return ComponentRenderer.render(parsed);
    } catch {
      return '';
    }
  }

  if (Array.isArray(input)) return ComponentRenderer.render(input);
  return '';
}

/**
 * Render a complete Discord message from data
 * @param {Object|string} input - Message object or JSON string
 * @returns {string} HTML string
 */
function renderMessage(input) {
  if (!input) return '';

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') {
        return MessageRenderer.render(parsed);
      }
    } catch {
      // Treat as plain text content
      return MessageRenderer.render({ content: input });
    }
  }

  return MessageRenderer.render(input);
}

/**
 * Render a Discord modal from data
 * @param {Object|string} input - Modal object or JSON string
 * @returns {string} HTML string
 */
function renderModal(input) {
  if (!input) return '';

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') {
        return ComponentRenderer.renderModal(parsed);
      }
    } catch {
      return '';
    }
  }

  return ComponentRenderer.renderModal(input);
}

/**
 * Try to auto-detect and render any Discord structure
 * @param {string} raw - Raw JSON or code string
 * @returns {{ type: string, html: string } | null}
 */
function autoRender(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // Try JSON parse
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    // Message (has content or embeds or components)
    if (parsed.content !== undefined || (parsed.embeds && Array.isArray(parsed.embeds))) {
      return { type: 'message', html: MessageRenderer.render(parsed) };
    }

    // Components array
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type !== undefined) {
      return { type: 'components', html: ComponentRenderer.render(parsed) };
    }

    // Single embed (has title, description, or fields)
    if (parsed.title || parsed.description || parsed.fields) {
      return { type: 'embed', html: EmbedRenderer.render(parsed) };
    }

    // Modal (has title and components with text inputs)
    if (parsed.title && parsed.components) {
      return { type: 'modal', html: ComponentRenderer.renderModal(parsed) };
    }
  } catch {
    // Not JSON — try builder code parsing
    const embedFromCode = EmbedRenderer.parseEmbedFromCode(raw);
    if (embedFromCode) {
      return { type: 'embed', html: EmbedRenderer.render(embedFromCode) };
    }
  }

  return null;
}

module.exports = {
  renderEmbed,
  renderComponents,
  renderMessage,
  renderModal,
  autoRender,
  // Re-export sub-renderers for direct access
  EmbedRenderer,
  ComponentRenderer,
  MessageRenderer
};
