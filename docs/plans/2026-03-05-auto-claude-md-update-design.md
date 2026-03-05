# Design — Auto-update CLAUDE.md

**Date:** 2026-03-05
**Feature:** Après une session chat, Claude analyse la conversation et suggère des mises à jour pour le CLAUDE.md du projet.
**Statut:** Approuvé

---

## Contexte

Claude Terminal permet de chatter avec Claude Code via l'Agent SDK. Après une session, Claude a souvent découvert des informations utiles sur le projet (architecture, conventions, dépendances) qui pourraient enrichir le CLAUDE.md. Cette feature automatise la capture de ces découvertes.

La feature est **activable/désactivable** dans les paramètres (activée par défaut).

---

## Flux d'exécution

```
Fermeture session chat (ChatView.js)
    ↓
Vérifier setting autoClaudeMdUpdate activé
    ↓
IPC: chat-analyze-session (messages[], projectPath)
    ↓
ChatService.analyzeSessionForClaudeMd()
    - Lit le CLAUDE.md existant (ou détecte son absence)
    - Tronque les messages si conversation trop longue (max ~50 messages)
    - Appelle l'API Anthropic (haiku) avec prompt ciblé
    ↓
API retourne JSON: suggestions[] = [{ title, section, content }]
    ↓
Si suggestions non vides → IPC réponse vers renderer
    ↓
ClaudeMdSuggestionModal.js s'affiche
    - Checkbox par suggestion
    - Bouton "Tout sélectionner / Désélectionner"
    - Si CLAUDE.md absent : "Ce fichier sera créé"
    ↓
Utilisateur coche les sections voulues → [Appliquer]
    ↓
IPC: claude-md-apply (projectPath, selectedSections[])
    ↓
Main process: lit/crée CLAUDE.md → insère sections à la fin
```

---

## Composants

### Nouveaux

| Fichier | Rôle |
|---------|------|
| `src/renderer/ui/components/ClaudeMdSuggestionModal.js` | Modal de review des suggestions avec checkboxes |

### Modifiés

| Fichier | Modification |
|---------|-------------|
| `src/main/services/ChatService.js` | Ajouter `analyzeSessionForClaudeMd(messages, projectPath)` |
| `src/main/ipc/chat.ipc.js` | Ajouter handlers `chat-analyze-session` et `claude-md-apply` |
| `src/main/preload.js` | Exposer les 2 nouveaux handlers IPC dans `window.electron_api.chat` |
| `src/renderer/ui/components/ChatView.js` | Déclencher l'analyse à la fermeture de session si setting activé |
| `src/renderer/state/settings.state.js` | Ajouter `autoClaudeMdUpdate: true` dans `defaultSettings` |
| `src/renderer/ui/panels/SettingsPanel.js` | Ajouter toggle dans l'onglet Claude |
| `src/renderer/i18n/locales/fr.json` | Clés FR pour la feature |
| `src/renderer/i18n/locales/en.json` | Clés EN pour la feature |

---

## Prompt API Anthropic

```
You are analyzing a conversation between a user and Claude Code to identify useful project discoveries.

Existing CLAUDE.md content (may be empty):
<existing_claude_md>
{existingContent}
</existing_claude_md>

Conversation:
<conversation>
{messages}
</conversation>

Identify 3-5 useful discoveries about this project (architecture, conventions, dependencies, patterns, commands, important files).
Only include information that is NOT already in the existing CLAUDE.md.
Return a JSON array only, no other text:
[
  {
    "title": "Short title (5-8 words)",
    "section": "## Section Heading",
    "content": "Markdown content to add to CLAUDE.md"
  }
]
If there are no new useful discoveries, return an empty array: []
```

**Modèle :** `claude-haiku-4-5-20251001`
**Tokens max entrée :** 50 derniers messages de la conversation si trop longue.

---

## UI — ClaudeMdSuggestionModal

```
┌─────────────────────────────────────────────────────┐
│  Mise à jour CLAUDE.md suggérée                  ✕  │
│─────────────────────────────────────────────────────│
│  Claude a découvert des informations utiles sur     │
│  ce projet. Sélectionnez les sections à ajouter.   │
│                                                     │
│  [Tout sélectionner]  [Tout désélectionner]         │
│                                                     │
│  ☑ Architecture du projet                           │
│    └ Le projet utilise une architecture MVC avec... │
│                                                     │
│  ☑ Commandes importantes                            │
│    └ `npm run build:renderer` est requis après...  │
│                                                     │
│  ☐ Dépendances clés                                │
│    └ xterm.js v6 avec addon-webgl pour...          │
│─────────────────────────────────────────────────────│
│              [Ignorer]    [Ajouter au CLAUDE.md]   │
└─────────────────────────────────────────────────────┘
```

**Si CLAUDE.md absent :**
- Message "Le fichier CLAUDE.md sera créé dans le projet"
- Bouton principal : "Créer le CLAUDE.md"

---

## Paramètre Settings

Dans l'onglet Claude des paramètres :

```
Auto-update CLAUDE.md
Propose des mises à jour du CLAUDE.md à la fin des sessions chat.
[Toggle ON/OFF]
```

Setting : `autoClaudeMdUpdate` (boolean, défaut: `true`)

---

## Clés i18n à ajouter

```json
"claudeMdUpdate": {
  "modalTitle": "Mise à jour CLAUDE.md suggérée",
  "modalSubtitle": "Claude a découvert des informations utiles. Sélectionnez les sections à ajouter.",
  "selectAll": "Tout sélectionner",
  "deselectAll": "Tout désélectionner",
  "dismiss": "Ignorer",
  "apply": "Ajouter au CLAUDE.md",
  "create": "Créer le CLAUDE.md",
  "willCreate": "Le fichier CLAUDE.md sera créé dans le projet.",
  "noSuggestions": "Aucune nouvelle découverte à ajouter.",
  "settingLabel": "Auto-update CLAUDE.md",
  "settingDesc": "Propose des mises à jour du CLAUDE.md à la fin des sessions chat."
}
```

---

## Gestion d'erreurs

- Si l'API Anthropic échoue → ne rien faire (pas d'erreur visible, la feature est silencieuse)
- Si CLAUDE.md non trouvé → proposer de le créer
- Si suggestions vides → ne pas afficher le modal
- Si le parsing JSON échoue → ne rien faire

---

## Non inclus (YAGNI)

- Historique des suggestions précédentes
- Suggestions pour d'autres fichiers (README, etc.)
- Analyse des sessions terminal (hors scope)
- Diff avant/après dans le modal
