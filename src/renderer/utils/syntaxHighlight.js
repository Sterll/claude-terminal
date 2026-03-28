/**
 * Syntax Highlighting (highlight.js)
 * Professional-grade highlighting with selective language loading.
 */

const { escapeHtml } = require('./dom');
const hljs = require('highlight.js/lib/core');

// Register languages selectively (not the full 192-lang bundle)
hljs.registerLanguage('javascript', require('highlight.js/lib/languages/javascript'));
hljs.registerLanguage('typescript', require('highlight.js/lib/languages/typescript'));
hljs.registerLanguage('python', require('highlight.js/lib/languages/python'));
hljs.registerLanguage('lua', require('highlight.js/lib/languages/lua'));
hljs.registerLanguage('xml', require('highlight.js/lib/languages/xml'));
hljs.registerLanguage('css', require('highlight.js/lib/languages/css'));
hljs.registerLanguage('scss', require('highlight.js/lib/languages/scss'));
hljs.registerLanguage('less', require('highlight.js/lib/languages/less'));
hljs.registerLanguage('json', require('highlight.js/lib/languages/json'));
hljs.registerLanguage('yaml', require('highlight.js/lib/languages/yaml'));
hljs.registerLanguage('bash', require('highlight.js/lib/languages/bash'));
hljs.registerLanguage('sql', require('highlight.js/lib/languages/sql'));
hljs.registerLanguage('rust', require('highlight.js/lib/languages/rust'));
hljs.registerLanguage('go', require('highlight.js/lib/languages/go'));
hljs.registerLanguage('java', require('highlight.js/lib/languages/java'));
hljs.registerLanguage('cpp', require('highlight.js/lib/languages/cpp'));
hljs.registerLanguage('c', require('highlight.js/lib/languages/c'));
hljs.registerLanguage('csharp', require('highlight.js/lib/languages/csharp'));
hljs.registerLanguage('php', require('highlight.js/lib/languages/php'));
hljs.registerLanguage('ruby', require('highlight.js/lib/languages/ruby'));
hljs.registerLanguage('markdown', require('highlight.js/lib/languages/markdown'));
hljs.registerLanguage('diff', require('highlight.js/lib/languages/diff'));
hljs.registerLanguage('kotlin', require('highlight.js/lib/languages/kotlin'));
hljs.registerLanguage('swift', require('highlight.js/lib/languages/swift'));
hljs.registerLanguage('powershell', require('highlight.js/lib/languages/powershell'));

// Max size for syntax highlighting (50KB) - plain text above this
const MAX_HIGHLIGHT_SIZE = 50 * 1024;

// Language alias map (extension/shorthand → hljs language name)
const LANG_MAP = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json',
  html: 'xml', htm: 'xml', xml: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  lua: 'lua',
  py: 'python',
  md: 'markdown', markdown: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  bat: 'powershell', ps1: 'powershell',
  sql: 'sql',
  rs: 'rust', rust: 'rust',
  go: 'go',
  java: 'java',
  cs: 'csharp', csharp: 'csharp',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  c: 'c', h: 'c',
  php: 'php',
  rb: 'ruby', ruby: 'ruby',
  diff: 'diff',
  kt: 'kotlin', kotlin: 'kotlin',
  swift: 'swift',
  powershell: 'powershell',
  javascript: 'javascript',
  typescript: 'typescript',
  python: 'python',
};

/**
 * Apply syntax highlighting to code
 * @param {string} code - Raw code string
 * @param {string} ext - File extension or language name
 * @returns {string} HTML with syntax spans
 */
function highlight(code, ext) {
  if (!code) return escapeHtml(code);
  const lang = LANG_MAP[ext] || ext;
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(code);

  // Size limit: highlight only the first portion, plain text for the rest
  if (code.length > MAX_HIGHLIGHT_SIZE) {
    const truncated = code.substring(0, MAX_HIGHLIGHT_SIZE);
    const rest = code.substring(MAX_HIGHLIGHT_SIZE);
    return hljs.highlight(truncated, { language: lang }).value + escapeHtml(rest);
  }

  return hljs.highlight(code, { language: lang }).value;
}

module.exports = {
  highlight,
  LANG_MAP
};
