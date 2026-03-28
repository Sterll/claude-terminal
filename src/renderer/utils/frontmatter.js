/**
 * Frontmatter Parser
 * Parse YAML frontmatter from markdown content with rich extraction
 */

/**
 * Parse YAML frontmatter from markdown content
 * @param {string} content - Markdown content
 * @returns {{ metadata: Object, body: string, parsed: Object }}
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const metadata = {};
  let body = content;

  if (match) {
    const yamlStr = match[1];
    body = match[2];

    yamlStr.split('\n').forEach(line => {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).trim();
        let value = line.slice(colonIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        metadata[key] = value;
      }
    });
  }

  // Build parsed object with fallbacks
  const tools = _parseTools(metadata.tools, content);

  let name = metadata.name || null;
  if (!name) {
    const titleMatch = body.match(/^#\s+(.+)/m);
    if (titleMatch) name = titleMatch[1].trim();
  }

  let description = metadata.description || null;
  if (!description) {
    description = _extractDescription(body);
  }

  const sections = [];
  const sectionMatches = content.matchAll(/^#{2,3}\s+(.+)/mg);
  for (const m of sectionMatches) {
    const title = m[1].trim();
    if (title && sections.length < 6) sections.push(title);
  }

  const parsed = {
    name,
    description,
    tools,
    sections,
    userInvocable: metadata['user-invocable'] === 'true',
    model: metadata.model || null
  };

  return { metadata, body, parsed };
}

/**
 * Parse tools from YAML value or body content
 */
function _parseTools(yamlValue, fullContent) {
  let tools = [];
  if (yamlValue) {
    const arrayMatch = yamlValue.match(/^\[([^\]]*)\]$/);
    if (arrayMatch) {
      tools = arrayMatch[1].split(',').map(t => t.trim().replace(/["']/g, '')).filter(Boolean);
    } else {
      tools = yamlValue.split(',').map(t => t.trim().replace(/["']/g, '')).filter(Boolean);
    }
  }
  if (tools.length === 0 && fullContent) {
    const bodyMatch = fullContent.match(/tools\s*:\s*\[([^\]]+)\]/i);
    if (bodyMatch) {
      tools = bodyMatch[1].split(',').map(t => t.trim().replace(/["']/g, '')).filter(Boolean);
    }
  }
  return tools;
}

/**
 * Extract description from markdown body (first meaningful paragraph)
 */
function _extractDescription(body) {
  const afterTitle = body.replace(/^#\s+.+\n/, '');
  const untilNextSection = afterTitle.split(/\n##\s/)[0];
  const paragraphs = untilNextSection.split(/\n\n+/);
  for (const p of paragraphs) {
    const cleaned = p.trim();
    if (cleaned && !cleaned.startsWith('#') && !cleaned.startsWith('```') &&
        !cleaned.match(/^\w+\s*:/) && cleaned.length > 10) {
      return cleaned.split('\n')[0].trim();
    }
  }
  return null;
}

module.exports = { parseFrontmatter };
