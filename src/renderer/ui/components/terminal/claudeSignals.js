/**
 * Reading Claude Code’s state out of a terminal’s scrollback.
 *
 * The CLI in a PTY announces nothing structured, so a tab that hosts it is
 * watched rather than queried: the screen is scraped for the shapes that mean
 * "still working" (a braille spinner, a tool line) as against "waiting for
 * you" (a prompt box). This is a heuristic by construction and is only ever
 * used to decide when to *stop* showing a busy state, never to decide what to
 * send.
 */

const { BUILTIN_TOOLS } = require('../../../utils/toolRegistry');

// Braille cells are what every CLI spinner in this ecosystem animates with.
const BRAILLE_SPINNER_RE = /[⠁-⣿]/;
const CLAUDE_TOOLS = new Set([...BUILTIN_TOOLS, 'TodoRead', 'Notebook']);

const TITLE_STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'a', 'a', 'en', 'dans', 'sur', 'pour', 'par', 'avec',
  'the', 'a', 'an', 'and', 'or', 'in', 'on', 'for', 'with', 'to', 'of', 'is', 'are', 'it', 'this', 'that',
  'me', 'moi', 'mon', 'ma', 'mes', 'ce', 'cette', 'ces', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles',
  'can', 'you', 'please', 'help', 'want', 'need', 'like', 'would', 'could', 'should',
  'peux', 'veux', 'fais', 'fait', 'faire', 'est', 'sont', 'ai', 'as', 'avez', 'ont'
]);

function detectCompletionSignal(terminal) {
  if (!terminal?.buffer?.active) return null;
  const buf = terminal.buffer.active;
  const totalLines = buf.baseY + buf.cursorY;
  const scanLimit = Math.max(0, totalLines - 10);
  const lines = [];

  for (let i = totalLines; i >= scanLimit; i--) {
    const row = buf.getLine(i);
    if (!row) continue;
    const text = row.translateToString(true).trim();
    if (!text || BRAILLE_SPINNER_RE.test(text) || /^[✳❯>$%#\s]*$/.test(text)) continue;
    lines.push(text);
    if (lines.length >= 5) break;
  }

  if (lines.length === 0) return null;
  const block = lines.join('\n');

  const doneMatch = block.match(/✳\s+\S+\s+for\s+((?:\d+h\s+)?(?:\d+m\s+)?\d+s)/);
  if (doneMatch) return { signal: 'done', duration: doneMatch[1] };

  if (/·\s+\S+…/.test(block)) return { signal: 'working' };

  if (/\b(Allow|Approve|yes\/no|y\/n)\b/i.test(block)) return { signal: 'permission' };

  if (lines[0].includes('⎿')) return { signal: 'tool_result' };

  return null;
}

function parseClaudeTitle(title) {
  const brailleMatch = title.match(/[\u2801-\u28FF]\s+(.*)/);
  const readyMatch = title.match(/\u2733\s+(.*)/);
  const content = (brailleMatch || readyMatch)?.[1]?.trim();
  const state = brailleMatch ? 'working' : readyMatch ? 'ready' : 'unknown';
  if (!content || content === 'Claude Code') return { state };
  const firstWord = content.split(/\s/)[0];
  if (CLAUDE_TOOLS.has(firstWord)) {
    return { state, tool: firstWord, toolArgs: content.substring(firstWord.length).trim() };
  }
  return { state, taskName: content };
}

function extractTitleFromInput(input) {
  let text = input.trim();
  if (text.startsWith('/') || text.length < 5) return null;
  const words = text.toLowerCase().replace(/[^\w\sàâäéèêëïîôùûüç-]/g, ' ').split(/\s+/)
    .filter(word => word.length > 2 && !TITLE_STOP_WORDS.has(word));
  if (words.length === 0) return null;
  const titleWords = words.slice(0, 4).map(w => w.charAt(0).toUpperCase() + w.slice(1));
  return titleWords.join(' ');
}

function extractTerminalContext(terminal) {
  if (!terminal?.buffer?.active) return null;
  const buf = terminal.buffer.active;
  const totalLines = buf.baseY + buf.cursorY;
  const scanLimit = Math.max(0, totalLines - 30);

  const lines = [];
  for (let i = totalLines; i >= scanLimit; i--) {
    const row = buf.getLine(i);
    if (!row) continue;
    const text = row.translateToString(true).trim();
    if (!text) continue;
    if (BRAILLE_SPINNER_RE.test(text)) continue;
    if (/^[✳❯>\$%#\s]*$/.test(text)) continue;
    lines.unshift(text);
    if (lines.length >= 6) break;
  }

  if (lines.length === 0) return null;

  const block = lines.join('\n');
  const lastLine = lines[lines.length - 1];

  const questionMatch = block.match(/^(.+\?)\s*$/m);
  if (questionMatch) {
    const q = questionMatch[1].trim();
    if (q.length > 10 && q.length <= 200) return { type: 'question', text: q };
  }

  if (/\b(allow|approve|permit|yes\/no|y\/n)\b/i.test(block) ||
      /\b(Run|Execute|Edit|Write|Read|Delete|Bash)\b.*\?/.test(block)) {
    return { type: 'permission', text: lastLine.length <= 120 ? lastLine : null };
  }

  return { type: 'done', text: null };
}

module.exports = {
  detectCompletionSignal,
  parseClaudeTitle,
  extractTitleFromInput,
  extractTerminalContext,
  CLAUDE_TOOLS,
  TITLE_STOP_WORDS,
  BRAILLE_SPINNER_RE,
};
