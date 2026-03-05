# Task-Session Linking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ajouter une liste de tâches légère par projet (todo/in_progress/done) avec liaison manuelle à une session Claude.

**Architecture:** Renderer-only — mêmes patterns que les `quickActions` dans `projects.state.js`. Pas de nouvel IPC. UI via `buildTasksHtml()` dans `DashboardService.js`, event listeners attachés après injection HTML. Stockage dans `projects.json` via `updateProject()` existant.

**Tech Stack:** JavaScript (ESM-compatible CJS), Jest/jsdom pour les tests, HTML string templates pour l'UI, CSS variables pour le theming.

---

## Task 1: Tests pour les fonctions CRUD des tâches

**Files:**
- Modify: `tests/state/projects.state.test.js` (append à la fin)

**Step 1: Écrire les tests (à la fin du fichier, après le bloc `quick actions`)**

Ouvrir `tests/state/projects.state.test.js`. Les imports en haut du fichier devront être complétés à l'étape 2 (après l'implémentation). Pour l'instant, écrire les tests dans un bloc `describe` séparé. Ajouter à la **fin** du fichier :

```js
// ── Tasks ──

describe('tasks', () => {
  beforeEach(() => {
    resetState({
      projects: [{ id: 'p1', name: 'A', path: '/a', folderId: null }],
    });
  });

  test('generateTaskId returns string starting with "task-"', () => {
    expect(generateTaskId().startsWith('task-')).toBe(true);
  });

  test('generateTaskId generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateTaskId()));
    expect(ids.size).toBe(10);
  });

  test('getTasks returns empty array by default', () => {
    expect(getTasks('p1')).toEqual([]);
  });

  test('getTasks returns empty array for unknown project', () => {
    expect(getTasks('nonexistent')).toEqual([]);
  });

  test('addTask creates task with correct defaults', () => {
    const task = addTask('p1', { title: 'Fix bug' });
    expect(task.id).toMatch(/^task-/);
    expect(task.title).toBe('Fix bug');
    expect(task.status).toBe('todo');
    expect(task.sessionId).toBeNull();
    expect(typeof task.createdAt).toBe('number');
    expect(typeof task.updatedAt).toBe('number');
    expect(task.createdAt).toBe(task.updatedAt);
  });

  test('addTask persists task to project state', () => {
    addTask('p1', { title: 'Fix bug' });
    expect(getTasks('p1')).toHaveLength(1);
    expect(getTasks('p1')[0].title).toBe('Fix bug');
  });

  test('addTask does nothing for unknown project', () => {
    const result = addTask('nonexistent', { title: 'Test' });
    expect(result).toBeNull();
  });

  test('updateTask changes status and bumps updatedAt', () => {
    const task = addTask('p1', { title: 'Test' });
    jest.advanceTimersByTime(100);
    updateTask('p1', task.id, { status: 'in_progress' });
    const updated = getTasks('p1')[0];
    expect(updated.status).toBe('in_progress');
    expect(updated.updatedAt).toBeGreaterThan(updated.createdAt);
  });

  test('updateTask can set sessionId', () => {
    const task = addTask('p1', { title: 'Test' });
    updateTask('p1', task.id, { sessionId: 'abc-123' });
    expect(getTasks('p1')[0].sessionId).toBe('abc-123');
  });

  test('updateTask does nothing for unknown taskId', () => {
    addTask('p1', { title: 'Test' });
    updateTask('p1', 'nonexistent', { status: 'done' });
    expect(getTasks('p1')[0].status).toBe('todo');
  });

  test('deleteTask removes task', () => {
    const task = addTask('p1', { title: 'Test' });
    deleteTask('p1', task.id);
    expect(getTasks('p1')).toHaveLength(0);
  });

  test('deleteTask does nothing for unknown taskId', () => {
    addTask('p1', { title: 'Test' });
    deleteTask('p1', 'nonexistent');
    expect(getTasks('p1')).toHaveLength(1);
  });
});
```

**Step 2: Vérifier que les tests échouent (les fonctions n'existent pas encore)**

```bash
cd E:\Perso\ClaudeTerminal-feat-task-list
npx jest tests/state/projects.state.test.js --testNamePattern="tasks" 2>&1 | tail -20
```

Expected: Erreur `generateTaskId is not a function` ou similaire (ReferenceError sur les imports manquants).

---

## Task 2: Implémenter les fonctions CRUD dans projects.state.js

**Files:**
- Modify: `src/renderer/state/projects.state.js`

**Step 1: Ajouter la fonction `generateTaskId` après `generateProjectId` (ligne ~37)**

```js
/**
 * Generate unique task ID
 * @returns {string}
 */
function generateTaskId() {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
```

**Step 2: Ajouter les fonctions CRUD des tâches après le bloc Quick Actions (après `reorderQuickActions`, vers ligne ~865)**

```js
// ── Tasks ──

/**
 * Get tasks for a project
 * @param {string} projectId
 * @returns {Array}
 */
function getTasks(projectId) {
  const project = getProject(projectId);
  return project?.tasks || [];
}

/**
 * Add a task to a project
 * @param {string} projectId
 * @param {{ title: string }} taskData
 * @returns {Object|null}
 */
function addTask(projectId, taskData) {
  if (!getProject(projectId)) return null;
  const now = Date.now();
  const task = {
    id: generateTaskId(),
    title: taskData.title,
    status: 'todo',
    sessionId: null,
    createdAt: now,
    updatedAt: now
  };
  const tasks = [...getTasks(projectId), task];
  updateProject(projectId, { tasks });
  return task;
}

/**
 * Update a task
 * @param {string} projectId
 * @param {string} taskId
 * @param {Object} updates
 */
function updateTask(projectId, taskId, updates) {
  const tasks = getTasks(projectId);
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  const updatedTasks = tasks.map(t =>
    t.id === taskId ? { ...t, ...updates, updatedAt: Date.now() } : t
  );
  updateProject(projectId, { tasks: updatedTasks });
}

/**
 * Delete a task
 * @param {string} projectId
 * @param {string} taskId
 */
function deleteTask(projectId, taskId) {
  const tasks = getTasks(projectId).filter(t => t.id !== taskId);
  updateProject(projectId, { tasks });
}
```

**Step 3: Ajouter les exports dans le `module.exports` à la fin du fichier**

Dans le bloc `module.exports = { ... }`, ajouter après `// Editor per project` :

```js
  // Tasks
  generateTaskId,
  getTasks,
  addTask,
  updateTask,
  deleteTask,
```

**Step 4: Ajouter les imports dans le fichier de test**

Dans `tests/state/projects.state.test.js`, ajouter dans le destructuring du `require` en haut :

```js
  generateTaskId,
  getTasks,
  addTask,
  updateTask,
  deleteTask,
```

**Step 5: Lancer les tests**

```bash
npx jest tests/state/projects.state.test.js 2>&1 | tail -20
```

Expected: tous les tests passent, y compris les nouveaux `tasks`.

**Step 6: Commit**

```bash
git add src/renderer/state/projects.state.js tests/state/projects.state.test.js
git commit -m "feat(tasks): add task CRUD functions to projects state"
```

---

## Task 3: i18n — Ajouter les clés tasks

**Files:**
- Modify: `src/renderer/i18n/locales/fr.json`
- Modify: `src/renderer/i18n/locales/en.json`

**Step 1: Ajouter dans `fr.json` (avant la dernière `}` du fichier)**

Trouver le dernier namespace dans `fr.json` et ajouter après lui :

```json
  "tasks": {
    "title": "Tâches",
    "add": "Ajouter",
    "addPlaceholder": "Titre de la tâche...",
    "noTasks": "Aucune tâche",
    "statusTodo": "À faire",
    "statusInProgress": "En cours",
    "statusDone": "Terminé",
    "start": "Démarrer",
    "complete": "Terminer",
    "delete": "Supprimer",
    "linkSession": "Lier session",
    "sessionLinked": "Session liée",
    "noActiveSession": "Aucune session trouvée pour ce projet"
  }
```

**Step 2: Ajouter dans `en.json`**

```json
  "tasks": {
    "title": "Tasks",
    "add": "Add",
    "addPlaceholder": "Task title...",
    "noTasks": "No tasks",
    "statusTodo": "To do",
    "statusInProgress": "In progress",
    "statusDone": "Done",
    "start": "Start",
    "complete": "Complete",
    "delete": "Delete",
    "linkSession": "Link session",
    "sessionLinked": "Session linked",
    "noActiveSession": "No session found for this project"
  }
```

**Step 3: Vérifier la validité JSON**

```bash
node -e "require('./src/renderer/i18n/locales/fr.json'); console.log('fr.json OK')"
node -e "require('./src/renderer/i18n/locales/en.json'); console.log('en.json OK')"
```

Expected: `fr.json OK` et `en.json OK`

**Step 4: Commit**

```bash
git add src/renderer/i18n/locales/fr.json src/renderer/i18n/locales/en.json
git commit -m "feat(tasks): add i18n keys for tasks"
```

---

## Task 4: CSS pour les tâches

**Files:**
- Modify: `styles/dashboard.css`

**Step 1: Trouver la fin du fichier `dashboard.css` et ajouter le bloc CSS**

Ajouter à la fin de `styles/dashboard.css` :

```css
/* ── Tasks Section ──────────────────────────────────────────── */

.tasks-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.tasks-header h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.tasks-header h3 svg {
  width: 14px;
  height: 14px;
}

.btn-task-add {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: var(--font-xs);
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-task-add:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.task-add-form {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}

.task-add-input {
  flex: 1;
  padding: 5px 8px;
  font-size: var(--font-sm);
  background: var(--bg-secondary);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  outline: none;
}

.task-add-confirm {
  padding: 5px 10px;
  font-size: var(--font-xs);
  background: var(--accent);
  border: none;
  border-radius: var(--radius-sm);
  color: #000;
  cursor: pointer;
  font-weight: 600;
}

.task-add-cancel {
  padding: 5px 8px;
  font-size: var(--font-xs);
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
}

.task-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  transition: border-color 0.15s ease;
}

.task-item:hover {
  border-color: var(--bg-hover);
}

.task-item.in-progress {
  border-color: var(--accent-dim);
  background: rgba(217, 119, 6, 0.05);
}

.task-item.done {
  opacity: 0.6;
}

.task-item.done .task-item-title {
  text-decoration: line-through;
  color: var(--text-muted);
}

.task-item-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--border-color);
}

.task-item.todo .task-item-status {
  background: var(--text-muted);
  border: 2px solid var(--text-muted);
  background: transparent;
}

.task-item.in-progress .task-item-status {
  background: var(--accent);
}

.task-item.done .task-item-status {
  background: var(--success);
}

.task-item-title {
  flex: 1;
  font-size: var(--font-sm);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-item-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.task-item:hover .task-item-actions {
  opacity: 1;
}

.btn-task-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
  font-size: 11px;
}

.btn-task-action:hover {
  background: var(--bg-hover);
  border-color: var(--border-color);
  color: var(--text-primary);
}

.btn-task-action.btn-task-start:hover {
  color: var(--accent);
}

.btn-task-action.btn-task-complete:hover {
  color: var(--success);
}

.btn-task-action.btn-task-delete:hover {
  color: var(--danger);
}

.task-session-badge {
  font-size: var(--font-2xs);
  padding: 1px 5px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-session-badge:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.tasks-empty {
  font-size: var(--font-xs);
  color: var(--text-muted);
  text-align: center;
  padding: 10px 0;
}
```

**Step 2: Commit**

```bash
git add styles/dashboard.css
git commit -m "feat(tasks): add CSS styles for task list"
```

---

## Task 5: buildTasksHtml() dans DashboardService.js

**Files:**
- Modify: `src/renderer/services/DashboardService.js`

**Step 1: Ajouter l'import de getTasks en haut du fichier**

Dans `DashboardService.js`, chercher la ligne qui importe depuis `'../state'` :

```js
const { projectsState, setGitPulling, ... } = require('../state');
```

Ajouter `getTasks` à ce destructuring :

```js
const { projectsState, ..., getTasks } = require('../state');
```

**Step 2: Ajouter la fonction `buildTasksHtml` avant `buildGitStatusHtml` (vers ligne 691)**

```js
/**
 * Build Tasks section HTML
 * @param {Object} project
 * @returns {string}
 */
function buildTasksHtml(project) {
  const tasks = getTasks(project.id);

  const taskItems = tasks.length > 0
    ? tasks.map(task => {
        const statusClass = task.status === 'in_progress' ? 'in-progress' : task.status;
        const sessionBadge = task.sessionId
          ? `<span class="task-session-badge" data-task-session="${escapeHtml(task.sessionId)}" title="${escapeHtml(task.sessionId)}">${task.sessionId.slice(0, 8)}…</span>`
          : '';

        const startBtn = task.status === 'todo'
          ? `<button class="btn-task-action btn-task-start" data-task-id="${escapeHtml(task.id)}" data-action="start" title="${t('tasks.start')}">▶</button>`
          : '';

        const completeBtn = task.status === 'in_progress'
          ? `<button class="btn-task-action btn-task-complete" data-task-id="${escapeHtml(task.id)}" data-action="complete" title="${t('tasks.complete')}">✓</button>`
          : '';

        const linkBtn = task.status === 'in_progress' && !task.sessionId
          ? `<button class="btn-task-action btn-task-link" data-task-id="${escapeHtml(task.id)}" data-action="link" title="${t('tasks.linkSession')}">🔗</button>`
          : '';

        const deleteBtn = `<button class="btn-task-action btn-task-delete" data-task-id="${escapeHtml(task.id)}" data-action="delete" title="${t('tasks.delete')}">✕</button>`;

        return `
          <div class="task-item ${statusClass}" data-task-id="${escapeHtml(task.id)}">
            <span class="task-item-status"></span>
            <span class="task-item-title">${escapeHtml(task.title)}</span>
            ${sessionBadge}
            <div class="task-item-actions">
              ${startBtn}${completeBtn}${linkBtn}${deleteBtn}
            </div>
          </div>
        `;
      }).join('')
    : `<div class="tasks-empty">${t('tasks.noTasks')}</div>`;

  return `
    <div class="dashboard-section">
      <div class="tasks-header">
        <h3>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
          ${t('tasks.title')}
        </h3>
        <button class="btn-task-add" id="task-btn-add">
          + ${t('tasks.add')}
        </button>
      </div>
      <div id="task-add-form" class="task-add-form" style="display:none">
        <input class="task-add-input" id="task-add-input" type="text" placeholder="${t('tasks.addPlaceholder')}" maxlength="120">
        <button class="task-add-confirm" id="task-add-confirm">↵</button>
        <button class="task-add-cancel" id="task-add-cancel">✕</button>
      </div>
      <div class="task-list" id="task-list">
        ${taskItems}
      </div>
    </div>
  `;
}
```

**Step 3: Intégrer `buildTasksHtml` dans `renderDashboard`**

Dans la fonction `renderDashboard`, chercher la partie où `dashboard-col` est assemblée (vers ligne 1416) :

```js
    <div class="dashboard-col">
      ${buildGitStatusHtml(gitInfo)}
```

La remplacer par :

```js
    <div class="dashboard-col">
      ${buildTasksHtml(project)}
      ${buildGitStatusHtml(gitInfo)}
```

**Step 4: Rebuild renderer pour tester visuellement**

```bash
npm run build:renderer
```

Expected: Pas d'erreur de build.

**Step 5: Commit**

```bash
git add src/renderer/services/DashboardService.js
git commit -m "feat(tasks): add buildTasksHtml to dashboard"
```

---

## Task 6: Event listeners pour les interactions de tâches

**Files:**
- Modify: `src/renderer/services/DashboardService.js`

**Step 1: Ajouter l'import de addTask, updateTask, deleteTask dans DashboardService.js**

Compléter la ligne d'import de `'../state'` :

```js
const { projectsState, ..., getTasks, addTask, updateTask, deleteTask } = require('../state');
```

**Step 2: Ajouter la fonction `attachTaskListeners` dans DashboardService.js (avant la fermeture du module)**

```js
/**
 * Attach event listeners to the task section in the dashboard container.
 * Call this after renderDashboard has injected HTML into the container.
 * @param {HTMLElement} container
 * @param {Object} project
 * @param {Function} onOpenClaude - callback to open Claude for the project
 * @param {Function} onRender - callback to re-render the dashboard
 */
function attachTaskListeners(container, project, onOpenClaude, onRender) {
  // Add button → show form
  container.querySelector('#task-btn-add')?.addEventListener('click', () => {
    const form = container.querySelector('#task-add-form');
    const input = container.querySelector('#task-add-input');
    if (form) { form.style.display = 'flex'; input?.focus(); }
  });

  // Confirm add
  const confirmAdd = () => {
    const input = container.querySelector('#task-add-input');
    const title = input?.value?.trim();
    if (!title) return;
    addTask(project.id, { title });
    if (onRender) onRender();
  };

  container.querySelector('#task-add-confirm')?.addEventListener('click', confirmAdd);

  container.querySelector('#task-add-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmAdd();
    if (e.key === 'Escape') {
      const form = container.querySelector('#task-add-form');
      const input = container.querySelector('#task-add-input');
      if (form) form.style.display = 'none';
      if (input) input.value = '';
    }
  });

  // Cancel add
  container.querySelector('#task-add-cancel')?.addEventListener('click', () => {
    const form = container.querySelector('#task-add-form');
    const input = container.querySelector('#task-add-input');
    if (form) form.style.display = 'none';
    if (input) input.value = '';
  });

  // Task action buttons (start / complete / link / delete)
  container.querySelector('#task-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) {
      // Click on session badge → show sessionId
      const badge = e.target.closest('[data-task-session]');
      if (badge) {
        const sessionId = badge.dataset.taskSession;
        navigator.clipboard?.writeText(sessionId).catch(() => {});
        window.dispatchEvent(new CustomEvent('show-toast', { detail: { message: `${t('tasks.sessionLinked')}: ${sessionId}` } }));
      }
      return;
    }

    const taskId = btn.dataset.taskId;
    const action = btn.dataset.action;

    if (action === 'start') {
      updateTask(project.id, taskId, { status: 'in_progress' });
      if (onOpenClaude) onOpenClaude(project);
      if (onRender) onRender();
    }

    if (action === 'complete') {
      updateTask(project.id, taskId, { status: 'done' });
      if (onRender) onRender();
    }

    if (action === 'link') {
      // Get most recent session for this project
      try {
        const sessions = await api.claude.sessions(project.path);
        if (sessions && sessions.length > 0) {
          const latestSessionId = sessions[0].sessionId;
          updateTask(project.id, taskId, { sessionId: latestSessionId });
          window.dispatchEvent(new CustomEvent('show-toast', { detail: { message: `${t('tasks.sessionLinked')}: ${latestSessionId.slice(0, 8)}…` } }));
          if (onRender) onRender();
        } else {
          window.dispatchEvent(new CustomEvent('show-toast', { detail: { message: t('tasks.noActiveSession') } }));
        }
      } catch (err) {
        console.error('[tasks] Failed to link session:', err);
      }
    }

    if (action === 'delete') {
      deleteTask(project.id, taskId);
      if (onRender) onRender();
    }
  });
}
```

**Step 3: Exposer `attachTaskListeners` dans le `module.exports` de DashboardService.js**

Chercher `module.exports` à la fin de `DashboardService.js` et ajouter :

```js
  attachTaskListeners,
```

**Step 4: Appeler `attachTaskListeners` dans `renderer.js`**

Dans `renderer.js`, trouver l'endroit où `DashboardService.renderDashboard` est appelé (vers ligne 623) :

```js
DashboardService.renderDashboard(content, project, {
  ...
  onOpenClaude: (proj) => {
    createTerminalForProject(proj);
    document.querySelector('[data-tab="claude"]')?.click();
  },
  ...
});
```

Après cet appel, ajouter :

```js
DashboardService.attachTaskListeners(content, project,
  (proj) => {
    createTerminalForProject(proj);
    document.querySelector('[data-tab="claude"]')?.click();
  },
  () => renderProjectDashboard()  // fonction de re-render existante
);
```

> **Note:** Identifier le nom exact de la fonction de re-render dans `renderer.js` en cherchant `renderDashboard` pour trouver la fonction englobante appelée lors de re-renders.

**Step 5: Rebuild renderer**

```bash
npm run build:renderer
```

Expected: Pas d'erreur.

**Step 6: Commit**

```bash
git add src/renderer/services/DashboardService.js renderer.js
git commit -m "feat(tasks): add task event listeners and interactions"
```

---

## Task 7: Tests et validation manuelle

**Step 1: Lancer tous les tests**

```bash
npm test 2>&1 | tail -30
```

Expected: Tous les tests passent (14+ suites).

**Step 2: Démarrer l'app et tester manuellement**

```bash
npm start
```

Vérifier :
- [ ] La section "Tâches" s'affiche dans le dashboard d'un projet
- [ ] Cliquer "+ Ajouter" affiche le formulaire inline
- [ ] Saisir un titre + Entrée crée une tâche en statut "À faire"
- [ ] "▶ Démarrer" passe la tâche en "En cours" et ouvre Claude
- [ ] "✓ Terminer" passe la tâche en "Terminé"
- [ ] "🔗 Lier session" lie la session la plus récente du projet
- [ ] "✕ Supprimer" retire la tâche
- [ ] Les tâches persistent après fermeture/réouverture de l'app
- [ ] Cliquer sur le badge de session affiche le sessionId

**Step 3: Commit final**

```bash
git add -A
git commit -m "feat(tasks): complete task-session linking feature"
```

---

## Résumé des fichiers modifiés

| Fichier | Changements |
|---------|------------|
| `src/renderer/state/projects.state.js` | +`generateTaskId`, `getTasks`, `addTask`, `updateTask`, `deleteTask` |
| `src/renderer/services/DashboardService.js` | +`buildTasksHtml`, `attachTaskListeners`, intégration dashboard |
| `styles/dashboard.css` | +styles section tasks |
| `src/renderer/i18n/locales/fr.json` | +namespace `tasks` |
| `src/renderer/i18n/locales/en.json` | +namespace `tasks` |
| `renderer.js` | +appel `attachTaskListeners` après `renderDashboard` |
| `tests/state/projects.state.test.js` | +suite de tests `tasks` |
