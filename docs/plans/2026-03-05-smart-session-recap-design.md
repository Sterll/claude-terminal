# Smart Session Recap — Design Document

**Date:** 2026-03-05
**Branch:** feat/smart-session
**Feature:** Résumé automatique des sessions Claude après chaque fin de session

---

## Objectif

Après chaque session Claude, générer automatiquement un résumé lisible et le persister dans le dashboard du projet. Exemple : *"Implémenté l'auth OAuth, corrigé 3 bugs API, ajouté les tests unitaires"*. Le développeur voit ce qui a été **accompli**, pas juste le temps passé.

---

## Décisions de design

| Question | Décision |
|----------|----------|
| Source du résumé | Haiku via GitHub Models API (même pattern que commitMessageGenerator) |
| Affichage | Section dédiée dans le dashboard projet |
| Données envoyées à Haiku | Outils + leurs fréquences + prompts utilisateur (max 5) |
| Format | 1 phrase si session simple, 2-3 bullet points si session riche (toolCount > 10 ou prompts > 2) |
| Persistance | `~/.claude-terminal/session-recaps/{projectId}.json`, max 5 entrées (FIFO) |

---

## Architecture

### Flux de données

```
SESSION_END (EventBus)
  └─► wireSessionRecapConsumer() [events/index.js]
          │
          └─► SessionRecapService.handleSessionEnd(projectId, enrichedContext)
                  │
                  ├─ Agrège : toolCounts (Map), prompts[], durationMs
                  ├─ Appel Haiku (GitHub Models API)
                  │     prompt adaptatif selon richesse de session
                  ├─ Fallback heuristique local si Haiku échoue
                  ├─ Persiste dans ~/.claude-terminal/session-recaps/{projectId}.json
                  └─ Émet événement pour refresh du dashboard
```

### Fichiers créés / modifiés

| Fichier | Action | Description |
|---------|--------|-------------|
| `src/renderer/services/SessionRecapService.js` | Créer | Service principal : agrégation, appel Haiku, persistance |
| `src/renderer/events/index.js` | Modifier | Enrichir `sessionContext` avec `toolCounts` et `prompts[]`, ajouter `wireSessionRecapConsumer()` |
| `src/renderer/services/DashboardService.js` | Modifier | Ajouter `buildSessionRecapsHtml()` + lecture du fichier JSON |
| `src/renderer/i18n/fr.json` | Modifier | Clés i18n section "Sessions récentes" |
| `src/renderer/i18n/en.json` | Modifier | Clés i18n section "Recent sessions" |
| `styles/dashboard.css` | Modifier | Styles de la section session recaps |

---

## Détail — SessionRecapService.js

### Contexte de session enrichi (dans events/index.js)

Le `sessionContext` existant est étendu avec :
- `toolCounts: Map<string, number>` — fréquence par outil (ex: `{ Write: 4, Edit: 3 }`)
- `prompts: string[]` — prompts utilisateur collectés via `PROMPT_SUBMIT`, max 5

### Logique d'appel Haiku

```js
const isRich = ctx.toolCount > 10 || ctx.prompts.length > 2;

const systemPrompt = isRich
  ? "Summarize this Claude Code session in 2-3 bullet points starting with '•'. Focus on what was ACCOMPLISHED. Imperative mood. No quotes. No trailing punctuation."
  : "Summarize this Claude Code session in ONE short sentence (max 15 words). Focus on what was ACCOMPLISHED. Imperative mood. No quotes. No trailing punctuation.";

const userMessage = `
User requests: ${ctx.prompts.join(' | ') || 'unknown'}
Tools used: ${formatToolCounts(ctx.toolCounts)}
Duration: ${formatDuration(ctx.durationMs)}
`;
```

**API cible :** GitHub Models API (`api.github.com/models`) avec `gpt-4o-mini` — même endpoint que `commitMessageGenerator.js`. Si pas de token GitHub, fallback local.

### Fallback heuristique local

```
"Write ×4, Edit ×3, Bash ×3 — 3 min"
```

### Format de persistance

```json
{
  "_version": 1,
  "recaps": [
    {
      "timestamp": 1709640000000,
      "summary": "• Implémenté l'auth OAuth\n• Corrigé 3 bugs API\n• Ajouté les tests unitaires",
      "durationMs": 720000,
      "toolCount": 15,
      "isRich": true
    }
  ]
}
```

Max 5 entrées. Tri chronologique inverse (plus récent en premier). Écriture atomique (tmp + rename via IPC).

---

## Détail — Section Dashboard

### Aperçu UI

```
┌─────────────────────────────────────────┐
│ 🕐 Sessions récentes                     │
├─────────────────────────────────────────┤
│ Il y a 2h · 12 min                      │
│ • Implémenté l'auth OAuth               │
│ • Corrigé 3 bugs API                    │
│ • Ajouté les tests unitaires            │
├─────────────────────────────────────────┤
│ Hier · 5 min                            │
│ Refactorisé le service de connexion     │
└─────────────────────────────────────────┘
```

- Timestamp relatif (`il y a 2h`, `hier`, `il y a 3 jours`)
- Durée de session à côté du timestamp
- Résumé en phrase ou bullets selon `isRich`
- Section masquée si aucune session enregistrée
- Lecture depuis `~/.claude-terminal/session-recaps/{projectId}.json` au chargement du dashboard

### Clés i18n

```json
"dashboard.sessionRecaps.title": "Sessions récentes",
"dashboard.sessionRecaps.empty": "Aucune session enregistrée",
"dashboard.sessionRecaps.duration": "{duration}",
"dashboard.sessionRecaps.ago.justNow": "À l'instant",
"dashboard.sessionRecaps.ago.minutes": "Il y a {n} min",
"dashboard.sessionRecaps.ago.hours": "Il y a {n}h",
"dashboard.sessionRecaps.ago.yesterday": "Hier",
"dashboard.sessionRecaps.ago.days": "Il y a {n} jours"
```

---

## Contraintes & Limites

- **Hooks uniquement** : le résumé n'est généré que si le provider actif est `hooks` (source de vérité fiable pour `SESSION_END`). Pas de résumé en mode scraping.
- **Session minimale** : pas de résumé si `toolCount < 2` (session trop courte, probablement annulée).
- **Timeout Haiku** : 5 secondes max. Si timeout → fallback heuristique.
- **Pas de blocage** : l'appel Haiku est entièrement async, n'impacte pas la performance de l'app.
- **Pas de retry** : si Haiku échoue, on persiste le fallback heuristique sans retry.
