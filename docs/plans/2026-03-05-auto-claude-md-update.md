# Auto-update CLAUDE.md Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** À la fermeture d'une session chat, analyser la conversation via l'API Anthropic et proposer à l'utilisateur d'ajouter les découvertes au CLAUDE.md du projet.

**Architecture:** Côté renderer, `ChatView.js` accumule les messages de la conversation dans une closure, et déclenche l'analyse à `destroy()`. Côté main process, `ChatService.analyzeSessionForClaudeMd()` appelle l'API Anthropic (haiku) pour générer des suggestions JSON. Un modal `ClaudeMdSuggestionModal.js` présente les suggestions avec checkboxes avant l'écriture dans le fichier.

**Tech Stack:** Electron IPC (ipcMain.handle), API Anthropic REST (fetch), Node.js fs (lecture/écriture CLAUDE.md), JavaScript vanille (modal).

---

## Task 1: Ajouter le setting `autoClaudeMdUpdate`

**Files:**
- Modify: `src/renderer/state/settings.state.js:12-47`

**Step 1: Ajouter le setting par défaut**

Dans `defaultSettings`, après `agentColors: {}`, ajouter :

```js
autoClaudeMdUpdate: true, // Suggest CLAUDE.md updates after chat sessions
```

**Step 2: Commit**

```bash
git add src/renderer/state/settings.state.js
git commit -m "feat(settings): add autoClaudeMdUpdate default setting"
```

---

## Task 2: Ajouter les clés i18n

**Files:**
- Modify: `src/renderer/i18n/locales/fr.json`
- Modify: `src/renderer/i18n/locales/en.json`

**Step 1: Ajouter dans `fr.json`**

Trouver la section `"settings"` et y ajouter (en fin de section) :

```json
"autoClaudeMdUpdate": "Auto-update CLAUDE.md",
"autoClaudeMdUpdateDesc": "Propose des mises à jour du CLAUDE.md à la fin des sessions chat."
```

Ajouter une nouvelle section `"claudeMdUpdate"` au même niveau que `"settings"` :

```json
"claudeMdUpdate": {
  "modalTitle": "Mise à jour CLAUDE.md suggérée",
  "modalSubtitle": "Claude a découvert des informations utiles sur ce projet. Sélectionnez les sections à ajouter.",
  "selectAll": "Tout sélectionner",
  "deselectAll": "Tout désélectionner",
  "dismiss": "Ignorer",
  "apply": "Ajouter au CLAUDE.md",
  "create": "Créer le CLAUDE.md",
  "willCreate": "Le fichier CLAUDE.md sera créé dans le projet.",
  "noSuggestions": "Aucune nouvelle découverte détectée."
}
```

**Step 2: Ajouter dans `en.json`**

```json
"autoClaudeMdUpdate": "Auto-update CLAUDE.md",
"autoClaudeMdUpdateDesc": "Suggest CLAUDE.md updates at the end of chat sessions."
```

```json
"claudeMdUpdate": {
  "modalTitle": "CLAUDE.md update suggested",
  "modalSubtitle": "Claude discovered useful information about this project. Select sections to add.",
  "selectAll": "Select all",
  "deselectAll": "Deselect all",
  "dismiss": "Dismiss",
  "apply": "Add to CLAUDE.md",
  "create": "Create CLAUDE.md",
  "willCreate": "The CLAUDE.md file will be created in this project.",
  "noSuggestions": "No new discoveries detected."
}
```

**Step 3: Commit**

```bash
git add src/renderer/i18n/locales/fr.json src/renderer/i18n/locales/en.json
git commit -m "feat(i18n): add claudeMdUpdate translations"
```

---

## Task 3: Toggle dans SettingsPanel

**Files:**
- Modify: `src/renderer/ui/panels/SettingsPanel.js`

**Step 1: Localiser le bloc `aiTabNaming` dans le HTML du panel**

Chercher `ai-tab-naming-toggle` dans le fichier (vers ligne 824). Juste après ce bloc de toggle (le `</div>` fermant), ajouter le toggle `autoClaudeMdUpdate` :

```js
<div class="settings-toggle-row">
  <div class="settings-toggle-info">
    <div>${t('settings.autoClaudeMdUpdate')}</div>
    <div class="settings-toggle-desc">${t('settings.autoClaudeMdUpdateDesc')}</div>
  </div>
  <label class="settings-toggle">
    <input type="checkbox" id="auto-claude-md-toggle" ${settings.autoClaudeMdUpdate !== false ? 'checked' : ''}>
    <span class="settings-toggle-slider"></span>
  </label>
</div>
```

**Step 2: Lire la valeur dans la fonction de sauvegarde**

Chercher `const newAiTabNaming = aiTabNamingToggle ? aiTabNamingToggle.checked : true;` (vers ligne 1314) et ajouter juste après :

```js
const autoClaudeMdToggle = document.getElementById('auto-claude-md-toggle');
const newAutoClaudeMd = autoClaudeMdToggle ? autoClaudeMdToggle.checked : true;
```

**Step 3: Inclure dans l'objet de settings sauvegardé**

Trouver `aiTabNaming: newAiTabNaming,` dans le bloc de sauvegarde (vers ligne 1352) et ajouter juste après :

```js
autoClaudeMdUpdate: newAutoClaudeMd,
```

**Step 4: Commit**

```bash
git add src/renderer/ui/panels/SettingsPanel.js
git commit -m "feat(settings): add autoClaudeMdUpdate toggle in settings panel"
```

---

## Task 4: `ChatService.analyzeSessionForClaudeMd()`

**Files:**
- Modify: `src/main/services/ChatService.js`

**Step 1: Ajouter la méthode à la classe `ChatService`**

En fin de classe (avant la dernière accolade fermante), ajouter :

```js
/**
 * Analyze a chat session conversation and suggest CLAUDE.md updates.
 * @param {Array<{role: string, content: string}>} messages - Conversation messages
 * @param {string} projectPath - Absolute path to the project
 * @returns {Promise<{suggestions: Array, claudeMdExists: boolean}>}
 */
async analyzeSessionForClaudeMd(messages, projectPath) {
  // Read existing CLAUDE.md (or empty string if not found)
  const claudeMdPath = require('path').join(projectPath, 'CLAUDE.md');
  let existingContent = '';
  try {
    existingContent = require('fs').readFileSync(claudeMdPath, 'utf8');
  } catch { /* file doesn't exist */ }

  const claudeMdExists = existingContent.length > 0;

  // Truncate to last 50 messages to stay within token limits
  const truncated = messages.slice(-50);

  // Build conversation text (skip very long tool outputs)
  const conversationText = truncated.map(m => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const truncContent = content.length > 2000 ? content.slice(0, 2000) + '...' : content;
    return `${m.role.toUpperCase()}: ${truncContent}`;
  }).join('\n\n');

  if (!conversationText.trim()) return { suggestions: [], claudeMdExists };

  const prompt = `You are analyzing a conversation between a user and Claude Code (an AI coding assistant).
Your goal: identify useful discoveries about the PROJECT that would help future Claude sessions.

Existing CLAUDE.md content (may be empty):
<existing_claude_md>
${existingContent || '(empty — file does not exist yet)'}
</existing_claude_md>

Conversation:
<conversation>
${conversationText}
</conversation>

Instructions:
- Identify 0-5 useful discoveries about the project (architecture, conventions, commands, dependencies, patterns, important files, gotchas).
- ONLY include information NOT already covered in the existing CLAUDE.md.
- Focus on facts that would help Claude work faster in future sessions on this project.
- Be concise. Each content block should be 1-5 lines of markdown.
- Return ONLY a valid JSON array, no other text:

[
  {
    "title": "Short title (5-8 words)",
    "section": "## Section Heading",
    "content": "Markdown content to add"
  }
]

If there are no new useful discoveries, return exactly: []`;

  try {
    // Use the Anthropic API key from Claude CLI credentials
    const credPath = require('path').join(require('os').homedir(), '.claude', '.credentials.json');
    let apiKey = null;
    try {
      const creds = JSON.parse(require('fs').readFileSync(credPath, 'utf8'));
      apiKey = creds.claudeAiOauth?.accessToken || creds.accessToken || null;
    } catch { /* no credentials */ }

    if (!apiKey) {
      console.warn('[ChatService] No Anthropic credentials found for CLAUDE.md analysis');
      return { suggestions: [], claudeMdExists };
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      console.warn(`[ChatService] CLAUDE.md analysis API error: ${response.status}`);
      return { suggestions: [], claudeMdExists };
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';

    // Parse JSON safely
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return { suggestions: [], claudeMdExists };

    const suggestions = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(suggestions)) return { suggestions: [], claudeMdExists };

    // Validate structure
    const valid = suggestions.filter(s =>
      s && typeof s.title === 'string' && typeof s.section === 'string' && typeof s.content === 'string'
    );

    return { suggestions: valid, claudeMdExists };
  } catch (err) {
    console.warn('[ChatService] CLAUDE.md analysis failed:', err.message);
    return { suggestions: [], claudeMdExists };
  }
}

/**
 * Apply selected CLAUDE.md sections to the project.
 * Creates CLAUDE.md if it doesn't exist, appends sections otherwise.
 * @param {string} projectPath
 * @param {Array<{section: string, content: string}>} sections
 */
applyClaudeMdSections(projectPath, sections) {
  if (!sections || sections.length === 0) return { success: true };

  const fs = require('fs');
  const path = require('path');
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');

  try {
    let existing = '';
    try { existing = fs.readFileSync(claudeMdPath, 'utf8'); } catch { /* new file */ }

    const toAppend = sections.map(s => `\n${s.section}\n\n${s.content}`).join('\n');
    const newContent = existing
      ? existing.trimEnd() + '\n' + toAppend + '\n'
      : toAppend.trimStart() + '\n';

    fs.writeFileSync(claudeMdPath, newContent, 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
```

**Step 2: Commit**

```bash
git add src/main/services/ChatService.js
git commit -m "feat(chat): add analyzeSessionForClaudeMd and applyClaudeMdSections methods"
```

---

## Task 5: Handlers IPC dans `chat.ipc.js`

**Files:**
- Modify: `src/main/ipc/chat.ipc.js`

**Step 1: Ajouter les 2 handlers avant le `}` de `registerChatHandlers`**

Chercher `// Cancel a background generation` (vers ligne 97) et ajouter juste avant :

```js
// Analyze chat session for CLAUDE.md suggestions
ipcMain.handle('chat-analyze-session', async (_event, { messages, projectPath }) => {
  try {
    return await chatService.analyzeSessionForClaudeMd(messages, projectPath);
  } catch (err) {
    console.error('[chat-analyze-session] Error:', err.message);
    return { suggestions: [], claudeMdExists: false };
  }
});

// Apply selected CLAUDE.md sections
ipcMain.handle('claude-md-apply', async (_event, { projectPath, sections }) => {
  try {
    return chatService.applyClaudeMdSections(projectPath, sections);
  } catch (err) {
    console.error('[claude-md-apply] Error:', err.message);
    return { success: false, error: err.message };
  }
});
```

**Step 2: Commit**

```bash
git add src/main/ipc/chat.ipc.js
git commit -m "feat(ipc): add chat-analyze-session and claude-md-apply handlers"
```

---

## Task 6: Exposer dans le Preload

**Files:**
- Modify: `src/main/preload.js`

**Step 1: Localiser la section `chat:` (vers ligne 303)**

Chercher `cancelGeneration: (params) => ipcRenderer.send('chat-cancel-generation', params)` et ajouter juste après (avant le `},` fermant de `chat:`) :

```js
analyzeSession: (params) => ipcRenderer.invoke('chat-analyze-session', params),
applyClaudeMd: (params) => ipcRenderer.invoke('claude-md-apply', params),
```

**Step 2: Commit**

```bash
git add src/main/preload.js
git commit -m "feat(preload): expose analyzeSession and applyClaudeMd in chat API"
```

---

## Task 7: Créer `ClaudeMdSuggestionModal.js`

**Files:**
- Create: `src/renderer/ui/components/ClaudeMdSuggestionModal.js`

**Step 1: Créer le fichier**

```js
/**
 * ClaudeMdSuggestionModal
 * Modal pour proposer des mises à jour du CLAUDE.md après une session chat.
 */

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils');

/**
 * Show the CLAUDE.md suggestion modal.
 * @param {Array<{title: string, section: string, content: string}>} suggestions
 * @param {boolean} claudeMdExists - Whether CLAUDE.md already exists
 * @param {string} projectPath - Absolute path to project
 * @returns {void}
 */
function showClaudeMdSuggestionModal(suggestions, claudeMdExists, projectPath) {
  if (!suggestions || suggestions.length === 0) return;

  const api = window.electron_api;

  // Remove existing modal if any
  const existing = document.getElementById('claude-md-suggestion-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'claude-md-suggestion-modal';
  overlay.className = 'modal-overlay';

  const suggestionsHtml = suggestions.map((s, i) => `
    <div class="claude-md-suggestion-item">
      <label class="claude-md-suggestion-label">
        <input type="checkbox" class="claude-md-suggestion-check" data-index="${i}" checked>
        <div class="claude-md-suggestion-info">
          <div class="claude-md-suggestion-title">${escapeHtml(s.title)}</div>
          <div class="claude-md-suggestion-section">${escapeHtml(s.section)}</div>
          <pre class="claude-md-suggestion-preview">${escapeHtml(s.content)}</pre>
        </div>
      </label>
    </div>
  `).join('');

  overlay.innerHTML = `
    <div class="modal modal-medium">
      <div class="modal-header">
        <div class="modal-title">${t('claudeMdUpdate.modalTitle')}</div>
        <button class="modal-close" id="claude-md-modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <p class="claude-md-modal-subtitle">${t('claudeMdUpdate.modalSubtitle')}</p>
        ${!claudeMdExists ? `<div class="claude-md-will-create">${t('claudeMdUpdate.willCreate')}</div>` : ''}
        <div class="claude-md-toggle-row">
          <button class="btn-text" id="claude-md-select-all">${t('claudeMdUpdate.selectAll')}</button>
          <button class="btn-text" id="claude-md-deselect-all">${t('claudeMdUpdate.deselectAll')}</button>
        </div>
        <div class="claude-md-suggestions-list">
          ${suggestionsHtml}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="claude-md-modal-dismiss">${t('claudeMdUpdate.dismiss')}</button>
        <button class="btn btn-primary" id="claude-md-modal-apply">
          ${claudeMdExists ? t('claudeMdUpdate.apply') : t('claudeMdUpdate.create')}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Close handlers
  function close() { overlay.remove(); }

  document.getElementById('claude-md-modal-close').addEventListener('click', close);
  document.getElementById('claude-md-modal-dismiss').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Select / deselect all
  document.getElementById('claude-md-select-all').addEventListener('click', () => {
    overlay.querySelectorAll('.claude-md-suggestion-check').forEach(cb => { cb.checked = true; });
  });
  document.getElementById('claude-md-deselect-all').addEventListener('click', () => {
    overlay.querySelectorAll('.claude-md-suggestion-check').forEach(cb => { cb.checked = false; });
  });

  // Apply
  document.getElementById('claude-md-modal-apply').addEventListener('click', async () => {
    const selected = [];
    overlay.querySelectorAll('.claude-md-suggestion-check').forEach(cb => {
      if (cb.checked) {
        const idx = parseInt(cb.dataset.index, 10);
        selected.push(suggestions[idx]);
      }
    });

    if (selected.length === 0) { close(); return; }

    const result = await api.chat.applyClaudeMd({ projectPath, sections: selected });
    if (result.success) {
      close();
    } else {
      console.error('[ClaudeMdSuggestionModal] Apply failed:', result.error);
      close();
    }
  });
}

module.exports = { showClaudeMdSuggestionModal };
```

**Step 2: Commit**

```bash
git add src/renderer/ui/components/ClaudeMdSuggestionModal.js
git commit -m "feat(ui): add ClaudeMdSuggestionModal component"
```

---

## Task 8: ChatView — tracking conversation + déclenchement à destroy()

**Files:**
- Modify: `src/renderer/ui/components/ChatView.js`

**Step 1: Ajouter le tableau `conversationHistory` dans la closure**

Chercher la liste des variables déclarées en début de `createChatView` (vers ligne 129-158, où sont déclarés `sessionId`, `isStreaming`, etc.). Ajouter après `let slashSelectedIndex = -1;` :

```js
// Accumulates messages for CLAUDE.md analysis (role: 'user'|'assistant', content: string)
const conversationHistory = [];
```

**Step 2: Enregistrer les messages utilisateur**

Dans `handleSend()`, chercher `appendUserMessage(text, images, mentions, isQueued);` (vers ligne 1503). Ajouter juste après :

```js
if (text) conversationHistory.push({ role: 'user', content: text });
```

**Step 3: Enregistrer les réponses assistant**

Chercher le listener `onDone` (ou équivalent) — c'est l'événement `chat-done`. Chercher `api.chat.onDone(` dans le fichier.

Ajouter dans le callback de `onDone`, après avoir récupéré le texte final de la réponse. Chercher `currentStreamText` dans le fichier pour trouver où le texte assistant est finalisé. Chercher `currentStreamText = '';` (reset) — juste avant ce reset, ajouter :

```js
if (currentStreamText) conversationHistory.push({ role: 'assistant', content: currentStreamText });
```

**Step 4: Déclencher l'analyse dans `destroy()`**

Localiser la méthode `destroy()` (vers ligne 3659). Chercher `if (sessionId) api.chat.close({ sessionId });` et ajouter juste après :

```js
// Trigger CLAUDE.md analysis if enabled and session had exchanges
const { getSetting } = require('../../state/settings.state');
if (getSetting('autoClaudeMdUpdate') !== false && conversationHistory.length >= 2 && project?.path) {
  const { showClaudeMdSuggestionModal } = require('./ClaudeMdSuggestionModal');
  api.chat.analyzeSession({ messages: conversationHistory, projectPath: project.path })
    .then(({ suggestions, claudeMdExists }) => {
      if (suggestions && suggestions.length > 0) {
        showClaudeMdSuggestionModal(suggestions, claudeMdExists, project.path);
      }
    })
    .catch(err => console.warn('[ChatView] CLAUDE.md analysis error:', err.message));
}
```

**Step 5: Vérifier que `project` est accessible dans `destroy()`**

`project` est passé en paramètre de `createChatView(wrapperEl, project, options)` — il est bien dans la closure.

**Step 6: Rebuild le renderer**

```bash
npm run build:renderer
```

Expected : Build successful, `dist/renderer.bundle.js` mis à jour.

**Step 7: Commit**

```bash
git add src/renderer/ui/components/ChatView.js
git commit -m "feat(chat): track conversation history and trigger CLAUDE.md analysis on destroy"
```

---

## Task 9: Styles CSS pour le modal

**Files:**
- Modify: `styles/modals.css`

**Step 1: Ajouter les styles en fin de fichier**

```css
/* ── ClaudeMdSuggestionModal ── */

.claude-md-modal-subtitle {
  color: var(--text-secondary);
  font-size: var(--font-sm);
  margin-bottom: 12px;
}

.claude-md-will-create {
  background: var(--accent-dim);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  color: var(--accent);
  font-size: var(--font-sm);
  padding: 8px 12px;
  margin-bottom: 12px;
}

.claude-md-toggle-row {
  display: flex;
  gap: 12px;
  margin-bottom: 10px;
}

.btn-text {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: var(--font-sm);
  padding: 0;
}

.btn-text:hover { text-decoration: underline; }

.claude-md-suggestions-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}

.claude-md-suggestion-item {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  transition: border-color 0.15s;
}

.claude-md-suggestion-item:has(.claude-md-suggestion-check:checked) {
  border-color: var(--accent);
}

.claude-md-suggestion-label {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
  padding: 10px 12px;
}

.claude-md-suggestion-check { margin-top: 3px; flex-shrink: 0; }

.claude-md-suggestion-title {
  font-size: var(--font-sm);
  font-weight: 500;
  color: var(--text-primary);
}

.claude-md-suggestion-section {
  font-size: var(--font-xs);
  color: var(--text-secondary);
  margin-top: 2px;
}

.claude-md-suggestion-preview {
  font-size: var(--font-xs);
  color: var(--text-muted);
  margin-top: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 60px;
  overflow: hidden;
  font-family: monospace;
}
```

**Step 2: Rebuild**

```bash
npm run build:renderer
```

**Step 3: Commit**

```bash
git add styles/modals.css
git commit -m "feat(styles): add ClaudeMdSuggestionModal styles"
```

---

## Task 10: Test manuel end-to-end

**Step 1: Lancer l'app**

```bash
npm start
```

**Step 2: Vérifier le setting**

- Ouvrir Paramètres → section Claude
- Vérifier que le toggle "Auto-update CLAUDE.md" apparaît et est coché par défaut

**Step 3: Tester avec un projet**

- Ouvrir un projet avec ou sans CLAUDE.md
- Ouvrir un onglet Chat
- Envoyer au moins 2 messages ("Quel est le framework utilisé ?" puis voir la réponse)
- Fermer l'onglet chat (croix de fermeture)
- Vérifier que le modal apparaît avec des suggestions cochables

**Step 4: Appliquer une suggestion**

- Cocher 1-2 suggestions et cliquer "Ajouter au CLAUDE.md"
- Vérifier que le fichier CLAUDE.md du projet a bien été mis à jour

**Step 5: Tester désactivation**

- Désactiver le toggle dans les paramètres
- Répéter : fermer un onglet chat → vérifier qu'aucun modal n'apparaît

**Step 6: Commit final si tout OK**

```bash
git add -A
git commit -m "feat(claude-md): auto-update CLAUDE.md after chat sessions"
```

---

## Notes d'implémentation

- **`destroy()` est synchrone** : l'appel à `analyzeSession` doit être async/non-bloquant (`.then()` sans `await`)
- **Sécurité API key** : utiliser les credentials OAuth du CLI Claude (`~/.claude/.credentials.json`). Si absent, la feature est silencieuse.
- **Minimum 2 messages** dans `conversationHistory` pour déclencher (1 user + 1 assistant) — évite les sessions vides
- **Pas de retry** : si l'API échoue, on ne montre rien (feature silencieuse)
- **`currentStreamText`** : chercher dans ChatView.js comment le texte assistant est construit via stream avant de modifier (localiser `currentStreamText` pour voir le pattern exact)
