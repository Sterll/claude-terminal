/**
 * SessionBriefService
 *
 * "Where was I?" for a conversation the user comes back to: what it is for,
 * where it stands, what was decided, and what to know before carrying on.
 * Written by Haiku from the session's own transcript, and only when the user
 * asks: every brief is a model call billed to their usage, so nothing here
 * runs on its own.
 *
 * A brief is cached per session together with a cursor into the transcript.
 * Opening it again shows the cached one at once and says how many messages
 * came after it; updating sends the previous brief plus those messages only,
 * so a long session is never read in full a second time.
 *
 * The transcript is condensed before it is sent. Tool output is the bulk of a
 * transcript and says little about intent, so it is dropped: what remains is
 * what the user asked, what Claude answered, one line per tool call, and the
 * answers the user gave to Claude's questions, which are decisions.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 1;

// ~15k tokens of transcript: enough for a long session once tool output is
// gone, and cheap on Haiku. Past it the middle is elided, never the ends: the
// opening says what the session is for, the tail where it stands.
const DEFAULT_BUDGET = 60_000;

// Spawning the CLI alone takes several seconds, and the prompt is large.
const PROMPT_TIMEOUT_MS = 90_000;

// Two passes: the full rendering, then a compact one if it does not fit.
const FULL = { user: 1500, assistant: 1500, toolLines: 12, plan: 1200 };
const COMPACT = { user: 600, assistant: 500, toolLines: 0, plan: 500 };

const LANGUAGE_NAMES = {
  fr: 'French',
  en: 'English',
  es: 'Spanish',
  id: 'Indonesian',
  'zh-CN': 'Simplified Chinese',
  'pt-BR': 'Brazilian Portuguese',
};

const SYSTEM_PROMPT = `You brief a developer coming back to a coding session they ran with Claude Code and no longer remember. In under a minute of reading they need to know what the session is for, where it stands, what was decided, and what to know before carrying on.

Reply with one JSON object and nothing else:
{"about": string, "status": string, "decisions": string[], "notes": string[]}

- about: one or two sentences. The goal of the session, not its history.
- status: one to three sentences. What is done, what is in progress, and whether something is waiting on the user (a question, a review, a choice).
- decisions: at most 6. Choices actually made, by the user or agreed with them, each with its reason when the transcript gives one ("X, because Y"). Not options that were only considered. Empty array if there are none.
- notes: at most 5. What the user should know before continuing: open questions, caveats, things left out or postponed on purpose, risks, surprises found along the way. Empty array if there are none.

The reader is the user of the session: address them as "you" and call the assistant Claude. Be concrete: name the files, commands, branches and pull requests involved. Wrap file names, commands and identifiers in backticks. No preamble, no filler, no restating the headings. Never use the em dash character; use a comma, a colon or a hyphen instead.`;

// ── Transcript condensing ──

function oneLine(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function clip(text, max) {
  const trimmed = String(text || '').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}… [cut]` : trimmed;
}

/** The one argument that says what a tool call was about. */
function toolTarget(input) {
  if (!input || typeof input !== 'object') return '';
  const value = input.file_path || input.notebook_path || input.command || input.pattern
    || input.url || input.query || input.description || input.skill || input.path || '';
  return oneLine(value, 120);
}

function isMessage(msg) {
  return msg.role === 'user' || (msg.role === 'assistant' && msg.type === 'text');
}

/**
 * The transcript as lines of text, in one of the two detail levels.
 * @param {Array<object>} messages - As returned by `loadSessionHistory`
 * @param {typeof FULL} level
 * @returns {string[]}
 */
function renderLines(messages, level) {
  const lines = [];
  let run = []; // tool calls since the last thing said

  const flushRun = () => {
    if (!run.length) return;
    if (level.toolLines) {
      for (const call of run.slice(0, level.toolLines)) {
        lines.push(`  · ${call.name}${call.target ? ` ${call.target}` : ''}`);
      }
      if (run.length > level.toolLines) lines.push(`  · … ${run.length - level.toolLines} more tool calls`);
    } else {
      const counts = new Map();
      for (const call of run) counts.set(call.name, (counts.get(call.name) || 0) + 1);
      const summary = [...counts].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(', ');
      lines.push(`  · ${run.length} tool call${run.length > 1 ? 's' : ''}: ${summary}`);
    }
    run = [];
  };

  for (const msg of messages) {
    if (msg.role === 'user') {
      flushRun();
      const images = msg.images?.length ? ` [${msg.images.length} image(s)]` : '';
      if (msg.text || images) lines.push(`User: ${clip(msg.text, level.user)}${images}`);
    } else if (msg.role === 'assistant' && msg.type === 'text') {
      flushRun();
      lines.push(`Claude: ${clip(msg.text, level.assistant)}`);
    } else if (msg.role === 'assistant' && msg.type === 'tool_use') {
      // A plan the user approves is the largest decision a session holds.
      if (msg.toolName === 'ExitPlanMode' && msg.toolInput?.plan) {
        flushRun();
        lines.push(`Claude proposed a plan: ${clip(msg.toolInput.plan, level.plan)}`);
      } else if (msg.toolName !== 'AskUserQuestion') {
        run.push({ name: msg.toolName || 'tool', target: toolTarget(msg.toolInput) });
      }
    } else if (msg.role === 'tool_result' && msg.answers) {
      flushRun();
      for (const [question, answer] of Object.entries(msg.answers)) {
        lines.push(`User answered "${oneLine(question, 200)}": ${oneLine(answer, 300)}`);
      }
    } else if (msg.role === 'notice' && msg.icon === 'compact') {
      flushRun();
      lines.push('[context compacted]');
    }
  }
  flushRun();
  return lines;
}

function sizeOf(lines) {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

/** Keep the opening and the tail, drop the middle. */
function elideMiddle(lines, budget) {
  const head = [];
  let headSize = 0;
  for (const line of lines) {
    if (headSize + line.length + 1 > budget * 0.25) break;
    head.push(line);
    headSize += line.length + 1;
  }
  const tail = [];
  let tailSize = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (tailSize + lines[i].length + 1 > budget * 0.75) break;
    tail.unshift(lines[i]);
    tailSize += lines[i].length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  return omitted > 0 ? [...head, `[… ${omitted} lines omitted …]`, ...tail] : lines;
}

/**
 * @param {Array<object>} messages
 * @param {{ budget?: number }} [options]
 * @returns {string}
 */
function condenseTranscript(messages, { budget = DEFAULT_BUDGET } = {}) {
  let lines = renderLines(messages, FULL);
  if (sizeOf(lines) > budget) lines = renderLines(messages, COMPACT);
  if (sizeOf(lines) > budget) lines = elideMiddle(lines, budget);
  return lines.join('\n');
}

// ── Brief parsing ──

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s*—\s*/g, ' - ').trim() : '';
}

/**
 * The brief out of the model's reply, or null when it is not one.
 * @param {string|null} text
 * @returns {{about: string, status: string, decisions: string[], notes: string[]}|null}
 */
function parseBrief(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const list = (value, max) => (Array.isArray(value) ? value.map(cleanText).filter(Boolean).slice(0, max) : []);
  const brief = {
    about: cleanText(obj.about),
    status: cleanText(obj.status),
    decisions: list(obj.decisions, 8),
    notes: list(obj.notes, 8),
  };
  return brief.about || brief.status ? brief : null;
}

// ── Cursor ──

/**
 * Where the transcript stood when a brief was written: the last message that
 * carries a uuid, and how many came after it. A count alone would survive a
 * rewind that rewrote the tail and silently skip what replaced it.
 */
function cursorOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].uuid) return { uuid: messages[i].uuid, after: messages.length - 1 - i };
  }
  return { uuid: null, after: messages.length };
}

/** What came after the cursor, or null when the cursor is no longer in the transcript. */
function messagesSince(messages, cursor) {
  if (!cursor) return null;
  let base = 0;
  if (cursor.uuid) {
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].uuid === cursor.uuid) { idx = i; break; }
    }
    if (idx < 0) return null;
    base = idx + 1;
  }
  return messages.slice(base + (cursor.after || 0));
}

function countMessages(messages) {
  return messages.filter(isMessage).length;
}

// ── Prompts ──

function languageName(code) {
  return LANGUAGE_NAMES[code] || LANGUAGE_NAMES.en;
}

function fullPrompt(transcript, language) {
  return `The session transcript, condensed: what the user wrote, what Claude replied, and one line per tool call.

<transcript>
${transcript}
</transcript>

Write the brief in ${languageName(language)}.`;
}

function updatePrompt(previous, transcript, language) {
  return `The brief you wrote earlier for this session:

<previous_brief>
${JSON.stringify(previous)}
</previous_brief>

What happened since, condensed the same way: what the user wrote, what Claude replied, one line per tool call.

<new_messages>
${transcript}
</new_messages>

Rewrite the brief so it covers the whole session as it stands now: keep what still holds, drop what was superseded, add what the new messages change. Write it in ${languageName(language)}.`;
}

// ── Service ──

/** Session ids name the cache file, so only an id-shaped one is accepted. */
function checkSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !/^[\w-]{1,128}$/.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
}

class SessionBriefService {
  /**
   * @param {object} deps
   * @param {(projectPath: string, sessionId: string) => Promise<Array<object>>} deps.loadMessages
   * @param {(opts: {systemPrompt: string, prompt: string, timeoutMs: number}) => Promise<string|null>} deps.runPrompt
   * @param {string} deps.dir - Where briefs are cached, one file per session
   * @param {number} [deps.budget]
   * @param {() => number} [deps.now]
   */
  constructor({ loadMessages, runPrompt, dir, budget = DEFAULT_BUDGET, now = Date.now }) {
    this.loadMessages = loadMessages;
    this.runPrompt = runPrompt;
    this.dir = dir;
    this.budget = budget;
    this.now = now;
    this.inflight = new Map(); // sessionId -> Promise, so a double click is one call
  }

  _file(sessionId) {
    return path.join(this.dir, `${sessionId}.json`);
  }

  /**
   * The cached brief, or null. An unreadable cache reads as absent: the file
   * holds one regenerable brief and nothing else, so starting over loses
   * nothing the user wrote.
   */
  async _read(sessionId) {
    try {
      const data = JSON.parse(await fs.promises.readFile(this._file(sessionId), 'utf8'));
      return data && data.brief ? data : null;
    } catch {
      return null;
    }
  }

  async _write(sessionId, entry) {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const file = this._file(sessionId);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
  }

  /**
   * The cached brief and how far the session has moved since. No model call.
   * @returns {Promise<{success: true, brief: object|null, generatedAt: number|null, language: string|null, newMessages: number, totalMessages: number}>}
   */
  async status({ projectPath, sessionId }) {
    checkSessionId(sessionId);
    const [cached, messages] = await Promise.all([this._read(sessionId), this.loadMessages(projectPath, sessionId)]);
    const totalMessages = countMessages(messages);
    if (!cached) {
      return { success: true, brief: null, generatedAt: null, language: null, newMessages: totalMessages, totalMessages };
    }
    const since = messagesSince(messages, cached.cursor);
    return {
      success: true,
      brief: cached.brief,
      generatedAt: cached.generatedAt,
      language: cached.language || null,
      newMessages: countMessages(since || messages),
      totalMessages,
    };
  }

  /**
   * Write the brief, or bring the cached one up to date.
   * @param {{projectPath: string, sessionId: string, language?: string}} params
   */
  async generate(params) {
    const { sessionId } = params;
    checkSessionId(sessionId);
    if (this.inflight.has(sessionId)) return this.inflight.get(sessionId);
    const run = this._generate(params).finally(() => this.inflight.delete(sessionId));
    this.inflight.set(sessionId, run);
    return run;
  }

  async _generate({ projectPath, sessionId, language = 'en' }) {
    const [cached, messages] = await Promise.all([this._read(sessionId), this.loadMessages(projectPath, sessionId)]);
    if (!countMessages(messages)) return { success: false, error: 'empty' };

    const since = cached ? messagesSince(messages, cached.cursor) : null;
    const sameLanguage = cached && (cached.language || 'en') === language;

    // Nothing new, and the cached one is in the language asked for.
    if (since && sameLanguage && !countMessages(since)) {
      return { success: true, brief: cached.brief, generatedAt: cached.generatedAt, language, newMessages: 0, totalMessages: countMessages(messages) };
    }

    const prompt = since
      ? updatePrompt(cached.brief, condenseTranscript(since, { budget: this.budget }), language)
      : fullPrompt(condenseTranscript(messages, { budget: this.budget }), language);

    const brief = parseBrief(await this.runPrompt({ systemPrompt: SYSTEM_PROMPT, prompt, timeoutMs: PROMPT_TIMEOUT_MS }));
    if (!brief) return { success: false, error: 'failed' };

    const entry = {
      _version: CACHE_VERSION,
      sessionId,
      brief,
      cursor: cursorOf(messages),
      generatedAt: this.now(),
      language,
      incremental: !!since,
    };
    try {
      await this._write(sessionId, entry);
    } catch (err) {
      // The brief is still worth showing; it will just be written again next time.
      console.warn(`[SessionBrief] Could not cache the brief for ${sessionId}: ${err.message}`);
    }
    return { success: true, brief, generatedAt: entry.generatedAt, language, newMessages: 0, totalMessages: countMessages(messages) };
  }
}

module.exports = {
  SessionBriefService,
  condenseTranscript,
  parseBrief,
  cursorOf,
  messagesSince,
  countMessages,
  SYSTEM_PROMPT,
  DEFAULT_BUDGET,
};
