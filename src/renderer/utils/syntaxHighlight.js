/**
 * Simple Syntax Highlighting
 * Regex-based highlighting for code preview
 */

const { escapeHtml } = require('./dom');

// Max size for syntax highlighting (50KB) - plain text above this
const MAX_HIGHLIGHT_SIZE = 50 * 1024;

// Language detection by extension
const LANG_MAP = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  jsx: 'javascript',
  json: 'json',
  html: 'html', htm: 'html',
  css: 'css', scss: 'css', less: 'css',
  lua: 'lua',
  py: 'python',
  md: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  bat: 'bash', ps1: 'bash',
  sql: 'sql',
  xml: 'html',
  rs: 'rust',
  go: 'go',
  java: 'java', cs: 'java', cpp: 'java', c: 'java', php: 'java',
  rb: 'ruby',
};

// Comment patterns by language
const COMMENT_PATTERNS = {
  lua: /(--[^\n]*)/g,
  sql: /(--[^\n]*)/g,
  python: /(#[^\n]*)/g,
  ruby: /(#[^\n]*)/g,
  bash: /(#[^\n]*)/g,
  yaml: /(#[^\n]*)/g,
  html: /(&lt;!--[\s\S]*?--&gt;)/g,
};
const DEFAULT_COMMENT_PATTERN = /(\/\/[^\n]*)/g;

const KEYWORDS = {
  javascript: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|default|from|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false|yield|delete|void|super|static|get|set)\b/g,
  typescript: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|default|from|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|undefined|true|false|yield|delete|void|super|static|get|set|type|interface|enum|namespace|declare|abstract|implements|readonly|as|is|keyof|infer|never|unknown|any)\b/g,
  python: /\b(def|class|return|if|elif|else|for|while|break|continue|import|from|as|try|except|finally|raise|with|yield|lambda|pass|del|global|nonlocal|assert|True|False|None|and|or|not|in|is|async|await|self)\b/g,
  lua: /\b(local|function|return|if|then|else|elseif|end|for|while|do|repeat|until|break|in|and|or|not|nil|true|false|goto|self)\b/g,
  html: /\b(DOCTYPE|html|head|body|div|span|script|style|link|meta|title|class|id|src|href|rel|type)\b/g,
  css: /\b(display|flex|grid|position|width|height|margin|padding|border|background|color|font|text|align|justify|content|items|overflow|z-index|opacity|transition|transform|animation|none|auto|inherit|initial|important)\b/g,
  json: null,
  markdown: null,
  yaml: /\b(true|false|null|yes|no)\b/g,
  bash: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|echo|export|source|alias|cd|ls|grep|sed|awk|cat|mkdir|rm|cp|mv|chmod|chown|sudo|apt|npm|node|git|docker)\b/g,
  sql: /\b(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TABLE|INTO|VALUES|SET|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|NULL|IS|IN|LIKE|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|AS|DISTINCT|COUNT|SUM|AVG|MAX|MIN|INDEX|PRIMARY|KEY|FOREIGN|REFERENCES|CASCADE|UNIQUE|DEFAULT|CHECK|CONSTRAINT|EXISTS|BETWEEN|UNION|ALL|ANY|CASE|WHEN|THEN|ELSE|END|BEGIN|COMMIT|ROLLBACK)\b/gi,
  rust: /\b(fn|let|mut|const|if|else|for|while|loop|break|continue|return|match|struct|enum|impl|trait|pub|use|mod|crate|self|super|as|in|ref|move|async|await|unsafe|where|type|true|false|Some|None|Ok|Err)\b/g,
  go: /\b(func|var|const|if|else|for|range|switch|case|default|break|continue|return|go|defer|select|chan|map|struct|interface|type|package|import|true|false|nil|make|new|len|cap|append|delete|copy|panic|recover)\b/g,
  java: /\b(public|private|protected|static|final|abstract|class|interface|extends|implements|return|if|else|for|while|do|switch|case|break|continue|new|this|super|try|catch|finally|throw|throws|import|package|void|int|long|float|double|boolean|char|byte|short|null|true|false|instanceof|synchronized|volatile|transient|native|enum|assert|override|using|namespace|string|var|const|virtual|struct)\b/g,
  ruby: /\b(def|class|module|return|if|elsif|else|unless|for|while|do|end|begin|rescue|ensure|raise|yield|block_given|include|require|attr_reader|attr_writer|attr_accessor|self|super|nil|true|false|and|or|not|in|puts|print|lambda|proc)\b/g,
};

/**
 * Apply syntax highlighting to code
 * @param {string} code - Raw code string
 * @param {string} ext - File extension
 * @returns {string} HTML with syntax spans
 */
function highlight(code, ext) {
  const lang = LANG_MAP[ext] || null;
  if (!lang) return escapeHtml(code);

  // Size limit: highlight only the first portion, plain text for the rest
  if (code.length > MAX_HIGHLIGHT_SIZE) {
    const truncated = code.substring(0, MAX_HIGHLIGHT_SIZE);
    const rest = code.substring(MAX_HIGHLIGHT_SIZE);
    return highlightCore(truncated, lang) + escapeHtml(rest);
  }

  return highlightCore(code, lang);
}

function highlightCore(code, lang) {
  if (lang === 'json') return highlightJSON(code);
  if (lang === 'markdown') return highlightMarkdown(code);

  let escaped = escapeHtml(code);
  const tokens = [];

  function protect(html) {
    const id = tokens.length;
    tokens.push(html);
    return `\x00T${id}\x00`;
  }

  const commentPattern = COMMENT_PATTERNS[lang] || DEFAULT_COMMENT_PATTERN;
  escaped = escaped.replace(commentPattern, (_, m) => protect(`<span class="syn-cmt">${m}</span>`));

  escaped = escaped.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, (_, m) => protect(`<span class="syn-str">${m}</span>`));
  escaped = escaped.replace(/(&#x27;(?:[^&]|&(?!#x27;))*?&#x27;)/g, (_, m) => protect(`<span class="syn-str">${m}</span>`));
  if (lang === 'javascript' || lang === 'typescript') {
    escaped = escaped.replace(/(&#96;(?:[^&]|&(?!#96;))*?&#96;)/g, (_, m) => protect(`<span class="syn-str">${m}</span>`));
  }

  escaped = escaped.replace(/\b(\d+\.?\d*)\b/g, (_, m) => protect(`<span class="syn-num">${m}</span>`));

  const kwRegex = KEYWORDS[lang];
  if (kwRegex) {
    escaped = escaped.replace(kwRegex, (_, m) => protect(`<span class="syn-kw">${m}</span>`));
  }

  escaped = escaped.replace(/\b([a-zA-Z_]\w*)\s*\(/g, (_, m) => protect(`<span class="syn-fn">${m}</span>`) + '(');

  escaped = escaped.replace(/\x00T(\d+)\x00/g, (_, i) => tokens[i]);

  return escaped;
}

function highlightJSON(code) {
  let escaped = escapeHtml(code);
  escaped = escaped.replace(/(&quot;[^&]*?&quot;)\s*:/g, '<span class="syn-fn">$1</span>:');
  escaped = escaped.replace(/:\s*(&quot;[^&]*?&quot;)/g, ': <span class="syn-str">$1</span>');
  escaped = escaped.replace(/:\s*(\d+\.?\d*)/g, ': <span class="syn-num">$1</span>');
  escaped = escaped.replace(/:\s*(true|false|null)\b/g, ': <span class="syn-kw">$1</span>');
  return escaped;
}

function highlightMarkdown(code) {
  let escaped = escapeHtml(code);
  escaped = escaped.replace(/^(#{1,6}\s.*)$/gm, '<span class="syn-kw">$1</span>');
  escaped = escaped.replace(/(\*\*[^*]+\*\*)/g, '<span class="syn-fn">$1</span>');
  escaped = escaped.replace(/(&#96;[^&]+?&#96;)/g, '<span class="syn-str">$1</span>');
  escaped = escaped.replace(/(\[[^\]]+\]\([^)]+\))/g, '<span class="syn-str">$1</span>');
  return escaped;
}

module.exports = {
  highlight
};
