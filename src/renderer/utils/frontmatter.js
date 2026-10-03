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
    body = match[2];
    Object.assign(metadata, _parseYamlMap(match[1]));
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
    userInvocable: (metadata['user-invocable'] || metadata.userInvocable) !== 'false',
    model: metadata.model || null
  };

  return { metadata, body, parsed };
}

function _unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Folded block scalar (`>`): lines of a paragraph join with a space, a blank
 * line becomes a line break.
 */
function _fold(lines) {
  const out = [];
  let paragraph = [];
  for (const line of lines) {
    if (line.trim()) {
      paragraph.push(line.trim());
    } else if (paragraph.length) {
      out.push(paragraph.join(' '));
      paragraph = [];
    }
  }
  if (paragraph.length) out.push(paragraph.join(' '));
  return out.join('\n');
}

/**
 * The top-level keys of a frontmatter block. Not a YAML parser: it covers what
 * skill and agent files actually contain, which a line-by-line `key: value`
 * read did not. A `description: >-` came back as the literal ">-", and every
 * indented line under it that held a colon ("Use this skill when:") turned
 * into a key of its own.
 *
 * Handled: plain and quoted scalars, plain scalars continued on indented
 * lines, literal (`|`) and folded (`>`) block scalars with their chomping
 * indicators, and block lists (`- item`), which come back comma-joined so
 * callers read them like an inline list.
 *
 * @param {string} yamlStr
 * @returns {Object<string, string>}
 */
function _parseYamlMap(yamlStr) {
  const map = {};
  const lines = yamlStr.split(/\r?\n/);
  const indentOf = l => l.match(/^\s*/)[0].length;
  // Keys sit at the indent of the first one; anything deeper continues the key above.
  const first = lines.find(l => l.trim() && !l.trim().startsWith('#'));
  const base = first ? indentOf(first) : 0;
  const nested = l => !!l.trim() && indentOf(l) > base;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || nested(line) || line.trim().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    const block = [];
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || nested(lines[j]))) {
      block.push(lines[j]);
      j++;
    }
    while (block.length && !block[block.length - 1].trim()) block.pop();
    i = j - 1;

    if (/^[|>][+-]?\d*$/.test(value)) {
      const filled = block.filter(l => l.trim());
      const indent = filled.length ? Math.min(...filled.map(l => l.match(/^\s*/)[0].length)) : 0;
      const text = block.map(l => l.slice(indent));
      map[key] = value[0] === '|' ? text.join('\n').trim() : _fold(text);
    } else if (!value && block.some(l => /^\s*-\s+/.test(l))) {
      map[key] = block
        .filter(l => /^\s*-\s+/.test(l))
        .map(l => _unquote(l.replace(/^\s*-\s+/, '').trim()))
        .join(', ');
    } else if (block.length && value && !/^["']/.test(value)) {
      map[key] = [value, ...block.map(l => l.trim()).filter(Boolean)].join(' ');
    } else {
      map[key] = _unquote(value);
    }
  }
  return map;
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
