# Worktree Dashboard — Design Document

**Date:** 2026-03-05
**Branche:** feat/worktree-dashboard
**Statut:** Approuvé

## Contexte

Les worktrees git sont actuellement affichés dans une section du git panel, projet par projet. Il n'existe pas de vue globale permettant de voir toutes les worktrees actives, leur état (fichiers dirty, lock), et le temps passé dessus.

## Objectif

Créer un onglet dédié "Worktrees" dans la sidebar qui agrège toutes les worktrees actives de tous les projets enregistrés, avec pour chaque worktree : branche, fichiers dirty, statut de lock, et temps passé aujourd'hui.

## Décisions de design

- **Placement** : Nouvel onglet dans la sidebar (`data-tab="worktrees"`), entre `git` et `database`
- **Portée** : Globale — tous les projets enregistrés
- **Approche données** : Scan complet au chargement (appels IPC parallèles), cache mémoire, refresh manuel + auto 30s
- **Temps passé** : Via correspondance `worktreePath` ↔ `projectId` dans `timetracking.json`; `—` si non suivi
- **Fichiers lockés** : Lock git (`wt.locked`) + fichiers dirty (`git status --short`)

## Architecture

### Flux de données

```
WorktreesDashboard.js (nouveau panel)
  ↓ pour chaque projet git enregistré
  → api.git.worktreeList({ projectPath })          // IPC existant
  → api.git.status({ projectPath: worktreePath })  // IPC existant, par worktree
  → timeTracking.getProjectTime(projectId)         // state existant
  ↓
  Agrégation par repo (déduplication via mainRepoPath)
  → Structure WorktreeGroup[]
```

### Structure de données

```js
// WorktreeGroup
{
  repoName: string,
  repoPath: string,
  worktrees: WorktreeEntry[]
}

// WorktreeEntry
{
  path: string,
  branch: string,
  isMain: boolean,
  isCurrent: boolean,   // path === projet actif
  locked: boolean,
  lockReason: string | null,
  dirtyFiles: string[], // depuis git status --short
  timeToday: number | null, // ms, null si non suivi
  linkedProjectId: string | null
}
```

### Déduplication des repos

Plusieurs projets peuvent pointer sur le même repo git (ex: worktrees enregistrés comme projets séparés). On déduplique en groupant par `mainRepoPath` obtenu via `git-worktree-detect` ou déduit du premier résultat `worktreeList`.

## UI Layout

```
┌─────────────────────────────────────────────────────┐
│  Worktrees                    [↻ Refresh]            │
│  3 repos · 7 worktrees actives                       │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │ ● claude-terminal          /path/to/repo     │   │
│  │                                              │   │
│  │  ◉ main              0 fichiers  2h14 auj.  │   │
│  │    [current]                                 │   │
│  │                                              │   │
│  │  ○ feat/worktree-dashboard   3 fichiers  —  │   │
│  │    🔒 locked: "in review"     [Ouvrir] [···]│   │
│  │                                              │   │
│  │  ○ fix/typo              1 fichier   45min  │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**Éléments UX :**
- Header : compteur global (X repos, Y worktrees actives), bouton refresh
- Worktree courant : badge `[current]`
- Worktree main : `◉`, autres : `○`
- Dirty files : count cliquable → tooltip liste des fichiers
- Temps : `2h14 auj.` si suivi, `—` sinon
- Lock : icône 🔒 + raison si présente
- Actions : `[Ouvrir]` (quick switch projet) + `[···]` menu contextuel (lock/unlock, remove, open folder)
- Loading : skeleton cards pendant le scan

## Fichiers impactés

| Action | Fichier |
|--------|---------|
| Créer | `src/renderer/ui/panels/WorktreesDashboard.js` |
| Créer | `styles/worktrees.css` |
| Modifier | `index.html` — onglet nav + div panel |
| Modifier | `src/renderer/index.js` — import + init panel |
| Modifier | `renderer.js` — require panel |
| Modifier | `src/renderer/i18n/locales/fr.json` |
| Modifier | `src/renderer/i18n/locales/en.json` |

## IPC utilisés (tous existants)

- `git-worktree-list` — liste les worktrees d'un repo
- `git-status` — statut git d'un path (pour dirty files)
- `git-worktree-detect` — détecte si un path est une worktree et retourne le mainRepoPath
- `git-worktree-lock` / `git-worktree-unlock` — actions depuis le menu `[···]`
- `git-worktree-remove` — suppression depuis le menu `[···]`

**Aucun nouvel IPC requis.**

## Clés i18n à ajouter (~15 clés)

```json
"worktreesDashboard.title": "Worktrees",
"worktreesDashboard.refresh": "Rafraîchir",
"worktreesDashboard.summary": "{repos} repos · {worktrees} worktrees actives",
"worktreesDashboard.noWorktrees": "Aucune worktree active",
"worktreesDashboard.noProjects": "Aucun projet git enregistré",
"worktreesDashboard.loading": "Scan en cours...",
"worktreesDashboard.current": "current",
"worktreesDashboard.dirtyFiles": "{count} fichier(s) modifié(s)",
"worktreesDashboard.noDirtyFiles": "Propre",
"worktreesDashboard.timeToday": "{time} auj.",
"worktreesDashboard.open": "Ouvrir",
"worktreesDashboard.lock": "Verrouiller",
"worktreesDashboard.unlock": "Déverrouiller",
"worktreesDashboard.remove": "Supprimer",
"worktreesDashboard.openFolder": "Ouvrir dans l'explorateur"
```
