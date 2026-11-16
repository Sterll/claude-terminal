/**
 * The Guide's content: short, checked tips for getting the most out of the
 * app and out of Claude Code inside it.
 *
 * Two rules keep it true, and tests/ui/guideContent.test.js holds both:
 *   - Everything about the app points at the real thing: `action.tab` is a
 *     screen in index.html, `action.settings` a Settings tab, `shortcut` an id
 *     of ShortcutsManager whose *current* binding is shown, never a key typed
 *     here. A tip whose target disappears fails the build.
 *   - Everything about Claude Code itself carries `source`, the official page
 *     it was checked against (code.claude.com, platform.claude.com), so a
 *     reader can verify it and the next editor knows where to re-check it.
 *     Checked on 2026-11-16.
 *
 * French and English are written; the other locales read the English text.
 * No em or en dash anywhere, same rule as the rest of the UI.
 */

'use strict';

const DOCS = 'https://code.claude.com/docs/en/';

/** @typedef {{ fr: string, en: string }} Text */
/**
 * @typedef {object} Tip
 * @property {string} id
 * @property {Text} title
 * @property {Text} body
 * @property {boolean} [essential]   - shown under "Essentials"
 * @property {string} [shortcut]     - ShortcutsManager id, displayed with the user's binding
 * @property {string[]} [keys]       - fixed keys (not rebindable), "Mod" = Cmd on macOS, Ctrl elsewhere
 * @property {string} [code]         - a command to type, with a copy button
 * @property {{ tab?: string, settings?: string, palette?: boolean, newProject?: boolean }} [action]
 * @property {string} [source]       - official page the tip was checked against
 */

/** @type {Array<{ id: string, icon: string, title: Text, intro: Text, tips: Tip[] }>} */
const CHAPTERS = [
  {
    id: 'start',
    icon: 'compass',
    title: { fr: 'Bien démarrer', en: 'Getting started' },
    intro: {
      fr: 'Les quatre gestes qui font gagner le plus de temps dès le premier jour.',
      en: 'The four moves that save the most time from day one.',
    },
    tips: [
      {
        id: 'new-project',
        essential: true,
        title: { fr: 'Créer un projet en un écran', en: 'Create a project in one screen' },
        body: {
          fr: 'Dossier existant, nouveau dossier, clone d\'un dépôt ou template : tout se fait dans la même fenêtre. Le type est détecté depuis le contenu du dossier. Vous pouvez aussi glisser un dossier du Finder sur la liste des projets.',
          en: 'Existing folder, new folder, cloned repository or template: all in the same dialog. The type is detected from the folder\'s content. You can also drop a folder from your file manager onto the project list.',
        },
        shortcut: 'newProject',
        action: { newProject: true },
      },
      {
        id: 'palette',
        essential: true,
        title: { fr: 'Tout est dans la palette', en: 'Everything is in the palette' },
        body: {
          fr: 'Écrans, commandes, projets, sessions, notes et astuces de ce guide : tapez quelques lettres et Entrée. C\'est le chemin le plus court vers n\'importe quelle fonction.',
          en: 'Screens, commands, projects, sessions, notes and the tips of this guide: type a few letters and press Enter. It is the shortest path to any feature.',
        },
        keys: ['Mod', 'K'],
        action: { palette: true },
      },
      {
        id: 'chat-or-terminal',
        title: { fr: 'Chat ou terminal : deux façons de parler à Claude', en: 'Chat or terminal: two ways to talk to Claude' },
        body: {
          fr: 'Le chat ajoute les mentions @, les images collées, le brief, le suivi git et les tickets. Le terminal est la CLI Claude Code telle quelle. Choisissez le mode par défaut dans Réglages, Claude, et basculez un onglet avec son bouton de mode.',
          en: 'The chat adds @ mentions, pasted images, the brief, git tracking and tickets. The terminal is the Claude Code CLI as is. Pick the default in Settings, Claude, and switch a tab with its mode button.',
        },
        action: { settings: 'claude' },
      },
      {
        id: 'resume',
        title: { fr: 'Reprendre une conversation', en: 'Resume a conversation' },
        body: {
          fr: 'Le panneau des sessions liste les conversations passées du projet, avec recherche et épingles. Une session reprise garde tout son contexte.',
          en: 'The sessions panel lists the project\'s past conversations, with search and pins. A resumed session keeps its whole context.',
        },
        shortcut: 'showSessionsPanel',
      },
      {
        id: 'focus-layout',
        title: { fr: 'La disposition Focus', en: 'The Focus layout' },
        body: {
          fr: 'Une seule barre en haut : projet, session, outils git, recherche et écrans. La barre latérale disparaît, la conversation prend toute la place. À activer dans Réglages, Thèmes, Disposition.',
          en: 'A single bar at the top: project, session, git tools, search and screens. The sidebar goes away and the conversation gets the room. Turn it on in Settings, Themes, Layout.',
        },
        action: { settings: 'themes' },
      },
    ],
  },

  {
    id: 'prompting',
    icon: 'message',
    title: { fr: 'Obtenir de meilleurs résultats', en: 'Getting better results' },
    intro: {
      fr: 'Ce que la documentation officielle de Claude Code recommande, appliqué à l\'application.',
      en: 'What the official Claude Code documentation recommends, applied to the app.',
    },
    tips: [
      {
        id: 'be-specific',
        essential: true,
        title: { fr: 'Soyez précis, donnez la matière', en: 'Be specific, hand over the material' },
        body: {
          fr: 'Nommez le fichier, décrivez le symptôme et dites à quoi ressemble « réparé ». Plutôt que de décrire, joignez : @file, une capture collée, la sortie d\'un terminal avec @terminal.',
          en: 'Name the file, describe the symptom and say what "fixed" looks like. Rather than describing, attach: @file, a pasted screenshot, a terminal\'s output with @terminal.',
        },
        source: `${DOCS}best-practices`,
      },
      {
        id: 'verify',
        essential: true,
        title: { fr: 'Donnez-lui un moyen de vérifier', en: 'Give it a way to check its work' },
        body: {
          fr: 'Des tests, un build, un linter ou une capture d\'écran : un critère qui passe ou échoue. Demandez la preuve (la commande lancée et sa sortie) plutôt qu\'un « c\'est corrigé ».',
          en: 'Tests, a build, a linter or a screenshot: a check that passes or fails. Ask for the evidence (the command it ran and its output) rather than "it is fixed".',
        },
        source: `${DOCS}best-practices`,
      },
      {
        id: 'plan-mode',
        essential: true,
        title: { fr: 'Le mode Plan avant les gros changements', en: 'Plan mode before big changes' },
        body: {
          fr: 'En mode Plan, Claude explore et propose un plan sans rien modifier tant que vous ne l\'avez pas validé. Choisissez-le dans le sélecteur de mode, en bas à gauche du chat.',
          en: 'In Plan mode Claude explores and proposes a plan without changing anything until you approve it. Pick it in the mode selector, bottom left of the chat.',
        },
        source: `${DOCS}permission-modes`,
      },
      {
        id: 'permission-modes',
        title: { fr: 'Choisir son mode d\'autorisation', en: 'Choosing a permission mode' },
        body: {
          fr: 'Manuel demande avant chaque modification ou commande. Accepter les modifications valide les éditions dans le projet. Auto laisse un classifieur bloquer les actions risquées. Ignorer les permissions ne demande plus rien : à réserver à un environnement jetable. Le choix vaut pour la conversation en cours.',
          en: 'Manual asks before every edit or command. Accept edits approves edits inside the project. Auto lets a classifier block risky actions. Bypass permissions never asks: keep it for a throwaway environment. The choice applies to the current conversation.',
        },
        source: `${DOCS}permission-modes`,
      },
      {
        id: 'effort',
        title: { fr: 'Régler l\'effort plutôt qu\'écrire « réfléchis bien »', en: 'Set the effort rather than writing "think hard"' },
        body: {
          fr: '« Think hard » n\'est plus un mot-clé : c\'est l\'effort qui décide. Montez-le (High, XHigh) pour un bug coriace, baissez-le pour itérer vite. Max est fait pour les problèmes difficiles laissés en autonomie et a tendance à trop réfléchir ailleurs. Réglage dans la puce modèle, en bas à droite.',
          en: '"Think hard" is no longer a keyword: the effort level decides. Raise it (High, XHigh) for a stubborn bug, lower it to iterate fast. Max is meant for hard unattended problems and tends to overthink elsewhere. Set it in the model chip, bottom right.',
        },
        source: `${DOCS}model-config`,
      },
      {
        id: 'correct-early',
        title: { fr: 'Corriger tôt, revenir en arrière', en: 'Correct early, go back' },
        body: {
          fr: 'Stop interrompt sans perdre le travail fait. Sur vos messages, « Restaurer les fichiers ici » ramène le code à ce moment ; sur ceux de Claude, « Brancher ici » repart d\'une copie. Les commandes shell ne sont pas suivies par ces points de restauration : gardez git à côté.',
          en: 'Stop interrupts without losing the work done. On your messages, "Rewind files to here" brings the code back to that point; on Claude\'s, "Fork from here" starts from a copy. Shell commands are not tracked by these checkpoints: keep git alongside.',
        },
        source: `${DOCS}checkpointing`,
      },
      {
        id: 'one-task',
        title: { fr: 'Une tâche, une conversation', en: 'One task, one conversation' },
        body: {
          fr: 'Entre deux sujets sans rapport, ouvrez une nouvelle session ou tapez /clear. Après deux corrections ratées, repartez de zéro avec un meilleur prompt plutôt que d\'empiler. L\'anneau de contexte, en bas à droite, montre ce qui occupe la fenêtre.',
          en: 'Between two unrelated topics, open a new session or type /clear. After two failed corrections, start over with a better prompt rather than piling on. The context ring, bottom right, shows what fills the window.',
        },
        code: '/clear',
        source: `${DOCS}best-practices`,
      },
      {
        id: 'btw',
        title: { fr: 'Une question en passant', en: 'A question on the side' },
        body: {
          fr: '/btw pose une question à côté sans l\'ajouter à l\'historique de la conversation.',
          en: '/btw asks a side question without adding it to the conversation\'s history.',
        },
        code: '/btw',
        source: `${DOCS}commands`,
      },
      {
        id: 'brief',
        title: { fr: 'Le brief de session', en: 'The session brief' },
        body: {
          fr: 'En haut de la colonne de session : de quoi parle la conversation, où elle en est, ce qui a été décidé. Rédigé à la demande (un appel Haiku), il se met à jour avec les seuls nouveaux messages. Avec un vault connecté, un bouton l\'ajoute à votre note du jour.',
          en: 'At the top of the session column: what the conversation is about, where it stands, what was decided. Written on request (one Haiku call), it updates from the new messages only. With a vault connected, a button adds it to your daily note.',
        },
      },
      {
        id: 'images',
        title: { fr: 'Images, PDF et fichiers', en: 'Images, PDFs and files' },
        body: {
          fr: 'Collez une capture, glissez des fichiers sur le chat ou utilisez le trombone : jusqu\'à 5 images et 5 PDF de 20 Mo chacun. Un fichier texte est inclus tel quel jusqu\'à 128 Ko.',
          en: 'Paste a screenshot, drop files on the chat or use the paperclip: up to 5 images and 5 PDFs of 20 MB each. A text file is included as is up to 128 KB.',
        },
      },
    ],
  },

  {
    id: 'context',
    icon: 'at',
    title: { fr: 'Mentions et contexte', en: 'Mentions and context' },
    intro: {
      fr: 'Tapez @ dans le chat : chaque mention envoie à Claude un contenu précis, au moment de l\'envoi.',
      en: 'Type @ in the chat: each mention sends Claude a precise piece of content, when the message is sent.',
    },
    tips: [
      {
        id: 'mention-file',
        essential: true,
        title: { fr: '@file, avec une plage de lignes', en: '@file, with a line range' },
        body: {
          fr: 'Joint le texte d\'un fichier du projet (500 lignes au plus). Ajoutez :10-40 au nom pour n\'envoyer que ces lignes.',
          en: 'Attaches a project file\'s text (500 lines at most). Add :10-40 to the name to send only those lines.',
        },
      },
      {
        id: 'mention-git',
        title: { fr: '@git, @terminal, @errors', en: '@git, @terminal, @errors' },
        body: {
          fr: '@git joint le diff en cours, @terminal les 200 dernières lignes d\'un terminal, @errors seulement les lignes d\'erreur. Idéal pour « pourquoi ce build échoue ? ».',
          en: '@git attaches the current diff, @terminal a terminal\'s last 200 lines, @errors only the error lines. Ideal for "why does this build fail?".',
        },
      },
      {
        id: 'mention-project',
        title: { fr: '@project et @conversation', en: '@project and @conversation' },
        body: {
          fr: '@project résume un autre projet (branche, état git, CLAUDE.md, README, arborescence). @conversation joint le résumé d\'une ancienne conversation pour reprendre là où elle s\'était arrêtée.',
          en: '@project summarizes another project (branch, git status, CLAUDE.md, README, file tree). @conversation attaches the digest of a past conversation to pick up where it stopped.',
        },
      },
      {
        id: 'mention-knowledge',
        title: { fr: '@knowledge, @doc, @vault, @tickets', en: '@knowledge, @doc, @vault, @tickets' },
        body: {
          fr: 'Une fiche de connaissances globales, un document d\'espace de travail, une note de votre vault (avec ses liens et rétroliens) ou un ticket avec son statut actuel.',
          en: 'A global knowledge entry, a workspace document, a note from your vault (with its links and backlinks) or a ticket with its current status.',
        },
      },
      {
        id: 'context-packs',
        title: { fr: 'Packs de contexte et templates de prompt', en: 'Context packs and prompt templates' },
        body: {
          fr: 'Un pack regroupe fichiers, dossiers, texte et règles à joindre d\'un coup avec @context. Un template insère un prompt prêt à l\'emploi avec @prompt, variables $branch ou $changedFiles comprises. Les deux se gèrent dans Réglages, Bibliothèque.',
          en: 'A pack bundles files, folders, text and rules to attach at once with @context. A template inserts a ready prompt with @prompt, variables like $branch or $changedFiles included. Both are managed in Settings, Library.',
        },
        action: { settings: 'library' },
      },
    ],
  },

  {
    id: 'memory',
    icon: 'brain',
    title: { fr: 'Mémoire : ce que Claude sait d\'une session à l\'autre', en: 'Memory: what Claude knows from one session to the next' },
    intro: {
      fr: 'Chaque session démarre sans souvenir. Tout ce qui doit durer passe par ces fichiers, que l\'écran Mémoire permet d\'éditer.',
      en: 'Every session starts with no recollection. Whatever must last goes through these files, which the Memory screen lets you edit.',
    },
    tips: [
      {
        id: 'claude-md',
        essential: true,
        title: { fr: 'Le CLAUDE.md du projet', en: 'The project\'s CLAUDE.md' },
        body: {
          fr: 'Lu au début de chaque session, dans le chat comme dans le terminal. Mettez-y ce que Claude ne peut pas deviner du code : les commandes exactes de test et de build, les pièges, les décisions d\'équipe, tout ce que vous avez dû corriger deux fois. Visez moins de 200 lignes, concrètes et vérifiables.',
          en: 'Read at the start of every session, in the chat and the terminal alike. Put in it what Claude cannot guess from the code: the exact test and build commands, the traps, the team\'s decisions, anything you had to correct twice. Aim for under 200 lines, concrete and checkable.',
        },
        action: { tab: 'memory' },
        source: `${DOCS}memory`,
      },
      {
        id: 'claude-md-not',
        title: { fr: 'Ce qui n\'a rien à faire dans CLAUDE.md', en: 'What does not belong in CLAUDE.md' },
        body: {
          fr: 'La description de l\'architecture (Claude la lit dans le code), les MAJUSCULES et « IMPORTANT » à répétition, les procédures en plusieurs étapes (une skill) et les règles qui doivent toujours s\'appliquer (un hook ou une règle de refus).',
          en: 'A description of the architecture (Claude reads it in the code), repeated CAPITALS and "IMPORTANT", multi-step procedures (a skill) and rules that must always hold (a hook or a deny rule).',
        },
        source: `${DOCS}best-practices`,
      },
      {
        id: 'init',
        title: { fr: 'Démarrer un CLAUDE.md avec /init', en: 'Start a CLAUDE.md with /init' },
        body: {
          fr: 'Claude analyse le projet et propose un premier CLAUDE.md, ou des améliorations s\'il existe déjà. Relisez et coupez : un fichier court est mieux suivi.',
          en: 'Claude analyses the project and proposes a first CLAUDE.md, or improvements if there is one. Read it and cut: a short file is followed better.',
        },
        code: '/init',
        source: `${DOCS}memory`,
      },
      {
        id: 'global-memory',
        title: { fr: 'Mémoire globale : vos préférences partout', en: 'Global memory: your preferences everywhere' },
        body: {
          fr: '~/.claude/CLAUDE.md s\'applique à tous vos projets : langue de réponse, style de commit, outils préférés. Les fichiers se cumulent, celui du projet est lu après.',
          en: '~/.claude/CLAUDE.md applies to all your projects: reply language, commit style, preferred tools. The files add up; the project\'s one is read after it.',
        },
        action: { tab: 'memory' },
        source: `${DOCS}memory`,
      },
      {
        id: 'auto-memory',
        title: { fr: 'La mémoire automatique', en: 'Auto memory' },
        body: {
          fr: 'Claude Code note de lui-même ce qu\'il apprend sur le projet. Dites « retiens que… » pour l\'y ajouter, « ajoute-le à CLAUDE.md » pour l\'écrire dans le fichier. Seules les 200 premières lignes de son index sont chargées. Consultable dans Mémoire, Mémoire auto.',
          en: 'Claude Code writes down what it learns about the project by itself. Say "remember that..." to add to it, "add it to CLAUDE.md" to write it in the file. Only the first 200 lines of its index are loaded. Browse it in Memory, Auto memory.',
        },
        action: { tab: 'memory' },
        source: `${DOCS}memory`,
      },
      {
        id: 'no-hash',
        title: { fr: 'Le raccourci # n\'existe plus', en: 'The # shortcut is gone' },
        body: {
          fr: 'Commencer un message par # pour mémoriser a été retiré de Claude Code. Demandez simplement à Claude de modifier CLAUDE.md, ou éditez-le dans l\'écran Mémoire.',
          en: 'Starting a message with # to memorize was removed from Claude Code. Just ask Claude to edit CLAUDE.md, or edit it in the Memory screen.',
        },
        source: `${DOCS}interactive-mode`,
      },
      {
        id: 'rules',
        title: { fr: 'Des règles par dossier avec .claude/rules', en: 'Per-folder rules with .claude/rules' },
        body: {
          fr: 'Un fichier .md dans .claude/rules/ avec un en-tête paths: (par exemple src/api/**) n\'est chargé que lorsque Claude travaille sur ces fichiers. Le CLAUDE.md reste court, les règles précises arrivent au bon moment.',
          en: 'A .md file in .claude/rules/ with a paths: header (for example src/api/**) only loads when Claude works on those files. CLAUDE.md stays short and the precise rules arrive at the right time.',
        },
        source: `${DOCS}memory`,
      },
      {
        id: 'imports',
        title: { fr: 'Importer un fichier dans CLAUDE.md', en: 'Import a file into CLAUDE.md' },
        body: {
          fr: 'Une ligne @docs/conventions.md dans CLAUDE.md inclut ce fichier, sur quatre niveaux au plus. Pratique pour organiser, mais le contenu importé compte quand même dans le contexte.',
          en: 'A line @docs/conventions.md in CLAUDE.md includes that file, four levels deep at most. Handy for organizing, but imported content still counts toward the context.',
        },
        source: `${DOCS}memory`,
      },
      {
        id: 'knowledge',
        title: { fr: 'Les connaissances globales', en: 'Global knowledge' },
        body: {
          fr: 'Des fiches valables pour tous les projets : un serveur, un client, une convention. Épinglées, elles sont chargées dans chaque session ; sinon Claude les retrouve à la demande. Citez-en une avec @knowledge.',
          en: 'Entries that hold across every project: a server, a client, a convention. Pinned ones load in every session; the others Claude finds on demand. Cite one with @knowledge.',
        },
        action: { tab: 'memory' },
      },
      {
        id: 'workspaces',
        title: { fr: 'Les espaces de travail', en: 'Workspaces' },
        body: {
          fr: 'Plusieurs projets liés (une API et ses clients) partagent une base de documents et de liens. L\'Advisor répond avec tout l\'espace en tête, et Claude peut y écrire ses décisions.',
          en: 'Several related projects (an API and its clients) share a base of documents and links. The Advisor answers with the whole workspace in mind, and Claude can write its decisions there.',
        },
        action: { tab: 'workspace' },
      },
    ],
  },

  {
    id: 'extend',
    icon: 'puzzle',
    title: { fr: 'Skills, agents, MCP et plugins', en: 'Skills, agents, MCP and plugins' },
    intro: {
      fr: 'Apprendre de nouveaux gestes à Claude sans alourdir chaque conversation.',
      en: 'Teaching Claude new moves without weighing down every conversation.',
    },
    tips: [
      {
        id: 'skills',
        essential: true,
        title: { fr: 'Les skills : des procédures à la demande', en: 'Skills: procedures on demand' },
        body: {
          fr: 'Un dossier avec un SKILL.md. Seuls son nom et sa description restent en contexte ; le reste n\'est lu que lorsque Claude s\'en sert, ou quand vous tapez /nom. Les anciennes commandes personnalisées sont devenues des skills.',
          en: 'A folder with a SKILL.md. Only its name and description stay in context; the rest is read when Claude uses it, or when you type /name. Former custom commands are now skills.',
        },
        action: { tab: 'skills' },
        source: `${DOCS}skills`,
      },
      {
        id: 'skill-description',
        title: { fr: 'Une bonne description de skill', en: 'A good skill description' },
        body: {
          fr: 'C\'est elle qui déclenche la skill : dites ce qu\'elle fait et quand l\'utiliser, avec les mots que vous emploieriez. Gardez SKILL.md sous 500 lignes. Pour une action à effet de bord (déployer, publier), ajoutez disable-model-invocation: true pour qu\'elle ne parte que sur votre demande.',
          en: 'It is what triggers the skill: say what it does and when to use it, in the words you would use. Keep SKILL.md under 500 lines. For an action with side effects (deploy, publish), add disable-model-invocation: true so it only runs when you ask.',
        },
        source: 'https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices',
      },
      {
        id: 'create-with-claude',
        title: { fr: 'Créer une skill ou un agent avec Claude', en: 'Create a skill or an agent with Claude' },
        body: {
          fr: 'Dans Skills ou Agents, « Nouveau » puis « Créer avec Claude » : décrivez le besoin, Claude écrit les fichiers pour un projet ou pour tous (~/.claude). Le Marketplace installe des skills publiées.',
          en: 'In Skills or Agents, "New" then "Create with Claude": describe the need and Claude writes the files for one project or for all (~/.claude). The Marketplace installs published skills.',
        },
        action: { tab: 'skills' },
      },
      {
        id: 'agents',
        title: { fr: 'Les sous-agents', en: 'Subagents' },
        body: {
          fr: 'Un agent travaille dans un contexte séparé et ne rend que sa conclusion : utile pour une recherche bruyante, une relecture indépendante ou du travail en parallèle. Limitez ses outils (par exemple Read, Grep, Glob). Pour forcer un agent précis, écrivez @agent-nom.',
          en: 'An agent works in a separate context and returns only its conclusion: useful for a noisy search, an independent review or parallel work. Limit its tools (for example Read, Grep, Glob). To force a given agent, write @agent-name.',
        },
        action: { tab: 'agents' },
        source: `${DOCS}sub-agents`,
      },
      {
        id: 'mcp',
        title: { fr: 'Les serveurs MCP', en: 'MCP servers' },
        body: {
          fr: 'Ils donnent à Claude de nouveaux outils (base de données, navigateur, services). Leurs définitions sont chargées à la demande, mais chaque serveur connecté ajoute ses noms à chaque tour : désactivez ceux qui ne servent pas. Dans le chat, /mcp reconnecte un serveur perdu.',
          en: 'They give Claude new tools (database, browser, services). Their definitions load on demand, but each connected server adds its names to every turn: turn off the ones you do not use. In the chat, /mcp reconnects a lost server.',
        },
        action: { tab: 'mcp' },
        code: '/mcp',
        source: `${DOCS}mcp`,
      },
      {
        id: 'plugins',
        title: { fr: 'Les plugins', en: 'Plugins' },
        body: {
          fr: 'Un plugin regroupe skills, agents, hooks et serveurs MCP. Chaque plugin actif coûte un peu de contexte à chaque tour : gardez ceux que vous utilisez vraiment.',
          en: 'A plugin bundles skills, agents, hooks and MCP servers. Each enabled plugin costs some context on every turn: keep the ones you actually use.',
        },
        action: { tab: 'plugins' },
        source: `${DOCS}plugins`,
      },
      {
        id: 'hooks',
        title: { fr: 'Les hooks : ce qui doit arriver à chaque fois', en: 'Hooks: what must happen every time' },
        body: {
          fr: 'Un hook lance une commande à un moment précis (avant un outil, après une modification, en fin de tour). Contrairement à une consigne dans CLAUDE.md, il ne s\'oublie jamais : formater après chaque édition, bloquer un fichier protégé. Tapez /hooks dans le chat pour les gérer dans un terminal.',
          en: 'A hook runs a command at a precise moment (before a tool, after an edit, at the end of a turn). Unlike an instruction in CLAUDE.md it is never forgotten: format after every edit, block a protected file. Type /hooks in the chat to manage them in a terminal.',
        },
        code: '/hooks',
        source: `${DOCS}hooks-guide`,
      },
    ],
  },

  {
    id: 'work',
    icon: 'git',
    title: { fr: 'Git, tâches et automatisations', en: 'Git, tasks and automations' },
    intro: {
      fr: 'Faire travailler Claude sur plusieurs fronts, et garder la main sur ce qui part dans le dépôt.',
      en: 'Getting Claude to work on several fronts, and keeping control over what goes into the repository.',
    },
    tips: [
      {
        id: 'git-screen',
        essential: true,
        title: { fr: 'Commits et pull requests', en: 'Commits and pull requests' },
        body: {
          fr: 'L\'écran Git propose un message de commit généré, un commit intelligent qui regroupe les changements, et la description d\'une PR. Relisez toujours ce qui part.',
          en: 'The Git screen offers a generated commit message, a smart commit that groups the changes, and a pull request description. Always read what goes out.',
        },
        action: { tab: 'git' },
      },
      {
        id: 'chat-git',
        title: { fr: 'L\'onglet Git d\'une conversation', en: 'A conversation\'s Git tab' },
        body: {
          fr: 'Il suit les branches et worktrees où la session a travaillé, ses pull requests et leurs checks. Un check rouge ? Le bouton de correction met le journal d\'erreur dans le chat.',
          en: 'It follows the branches and worktrees the session worked in, its pull requests and their checks. A red check? The fix button puts the error log into the chat.',
        },
      },
      {
        id: 'parallel',
        title: { fr: 'Tâches parallèles', en: 'Parallel tasks' },
        body: {
          fr: 'Un objectif découpé en sous-tâches indépendantes, chacune dans son worktree git et sa branche, puis fusionnées. Bien pour trois changements ou plus qui ne touchent pas les mêmes fichiers.',
          en: 'A goal split into independent sub-tasks, each in its own git worktree and branch, then merged. Good for three or more changes that do not touch the same files.',
        },
        action: { tab: 'tasks' },
      },
      {
        id: 'control-tower',
        title: { fr: 'La tour de contrôle', en: 'The Control Tower' },
        body: {
          fr: 'Tous les agents actifs, tous projets confondus : qui travaille, qui attend une réponse. Répondez ou interrompez sans changer d\'onglet.',
          en: 'Every active agent across projects: who is working, who waits for an answer. Reply or interrupt without switching tabs.',
        },
        action: { tab: 'control-tower' },
      },
      {
        id: 'split',
        title: { fr: 'La vue divisée', en: 'Split view' },
        body: {
          fr: 'Jusqu\'à quatre onglets d\'un même projet côte à côte : une conversation et son terminal de test, par exemple.',
          en: 'Up to four tabs of one project side by side: a conversation and its test terminal, for example.',
        },
        shortcut: 'splitRight',
      },
      {
        id: 'automations',
        title: { fr: 'Les automatisations', en: 'Automations' },
        body: {
          fr: 'Un prompt lancé tout seul, chaque jour, chaque semaine ou sur un événement (un push, un fichier modifié). Vous pouvez aussi demander à Claude d\'en créer une : « chaque lundi, résume les PR ouvertes ».',
          en: 'A prompt that runs on its own, daily, weekly or on an event (a push, a changed file). You can also ask Claude to create one: "every Monday, summarize the open pull requests".',
        },
        action: { tab: 'workflows' },
      },
      {
        id: 'tickets',
        title: { fr: 'Les tickets', en: 'Tickets' },
        body: {
          fr: 'Connectez Linear dans Réglages, Tickets. Démarrez une session depuis un ticket (avec sa branche), citez-en un avec @tickets, et l\'application propose de lier ceux qu\'elle détecte dans la conversation.',
          en: 'Connect Linear in Settings, Tickets. Start a session from a ticket (with its branch), cite one with @tickets, and the app offers to link the ones it detects in the conversation.',
        },
        action: { tab: 'tickets' },
      },
      {
        id: 'cost',
        title: { fr: 'Coûts et limites', en: 'Cost and limits' },
        body: {
          fr: 'L\'écran Coûts chiffre la consommation par projet, modèle et jour, et sépare votre part de celle des autres sur un compte partagé. Un modèle plus léger et un effort plus bas coûtent moins pour les tâches simples.',
          en: 'The Cost screen prices usage per project, model and day, and separates your share from others\' on a shared account. A lighter model and a lower effort cost less for simple tasks.',
        },
        action: { tab: 'cost' },
      },
    ],
  },

  {
    id: 'notes',
    icon: 'book',
    title: { fr: 'Notes et Obsidian', en: 'Notes and Obsidian' },
    intro: {
      fr: 'Votre vault Obsidian (ou n\'importe quel dossier de notes Markdown) relié à Claude, sans dupliquer Obsidian : vos notes restent des fichiers, lisibles des deux côtés.',
      en: 'Your Obsidian vault (or any folder of Markdown notes) connected to Claude, without duplicating Obsidian: your notes stay files, readable from both sides.',
    },
    tips: [
      {
        id: 'vault-connect',
        essential: true,
        title: { fr: 'Connecter votre vault', en: 'Connect your vault' },
        body: {
          fr: 'L\'écran Notes détecte les vaults qu\'Obsidian connaît sur cette machine, ou vous laisse choisir un dossier. Obsidian n\'a pas besoin d\'être ouvert : l\'application lit les fichiers et suit vos réglages (dossier des notes du jour, format de date, template).',
          en: 'The Notes screen detects the vaults Obsidian knows on this machine, or lets you pick a folder. Obsidian does not need to be running: the app reads the files and follows your settings (daily notes folder, date format, template).',
        },
        action: { tab: 'notes' },
      },
      {
        id: 'vault-mention',
        title: { fr: 'Citer une note avec @vault', en: 'Cite a note with @vault' },
        body: {
          fr: 'La note part avec ses tags et la liste des notes qu\'elle cite et qui la citent : Claude voit le voisinage, et peut aller lire la suite. Rien de votre vault n\'est envoyé sans votre geste.',
          en: 'The note goes with its tags and the list of notes it links to and that link to it: Claude sees the neighbourhood and can go and read further. Nothing from your vault is sent unless you do it.',
        },
      },
      {
        id: 'vault-tools',
        title: { fr: 'Claude cherche dans vos notes', en: 'Claude searches your notes' },
        body: {
          fr: 'Une fois le vault connecté, Claude peut chercher et lire vos notes quand vous y faites référence (« qu\'avais-je décidé pour l\'auth ? »). L\'accès en lecture se coupe dans l\'écran Notes ; l\'écriture est désactivée tant que vous ne l\'autorisez pas.',
          en: 'Once the vault is connected, Claude can search and read your notes when you refer to them ("what did I decide about auth?"). Read access can be turned off in the Notes screen; writing stays off until you allow it.',
        },
        action: { tab: 'notes' },
      },
      {
        id: 'vault-daily',
        title: { fr: 'La note du jour', en: 'The daily note' },
        body: {
          fr: 'Le bouton « Note du jour » du brief y ajoute le résumé de la session, sous un titre dédié et en bloc repliable. Si vous autorisez l\'écriture, demandez aussi à Claude « ajoute un point sur ce qu\'on a fait à ma note du jour ». Rien n\'est jamais remplacé, seulement ajouté.',
          en: 'The brief\'s "Daily note" button adds the session summary to it, under its own heading and as a folded block. If you allow writing, you can also ask Claude "add a summary of what we did to my daily note". Nothing is ever replaced, only added.',
        },
      },
      {
        id: 'vault-project',
        title: { fr: 'Faire travailler Claude dans le vault', en: 'Let Claude work inside the vault' },
        body: {
          fr: 'Pour ranger, relier ou synthétiser vos notes, ajoutez le vault comme projet. Un CLAUDE.md à sa racine fixe les règles : liens [[wikilinks]], frontmatter avec tags, ne pas déplacer les dossiers, demander avant de créer un fichier.',
          en: 'To tidy, link or synthesize your notes, add the vault as a project. A CLAUDE.md at its root sets the rules: [[wikilinks]], frontmatter with tags, do not move folders, ask before creating a file.',
        },
        action: { newProject: true },
      },
      {
        id: 'obsidian-skills',
        title: { fr: 'Les skills officielles d\'Obsidian', en: 'Obsidian\'s official skills' },
        body: {
          fr: 'L\'équipe d\'Obsidian publie des skills qui apprennent à Claude le Markdown d\'Obsidian, les Bases et JSON Canvas. Tapez ces deux commandes dans le chat, l\'une après l\'autre : elles s\'ouvrent dans un terminal Claude.',
          en: 'The Obsidian team publishes skills that teach Claude Obsidian\'s Markdown, Bases and JSON Canvas. Type these two commands in the chat, one after the other: they open in a Claude terminal.',
        },
        code: '/plugin marketplace add obsidianmd/obsidian-skills\n/plugin install obsidian@obsidian-skills',
        source: 'https://github.com/obsidianmd/obsidian-skills',
      },
    ],
  },

  {
    id: 'comfort',
    icon: 'sparkles',
    title: { fr: 'Ambiance et confort', en: 'Ambience and comfort' },
    intro: {
      fr: 'Un espace de travail agréable, sans sacrifier la lisibilité.',
      en: 'A pleasant workspace, without trading away readability.',
    },
    tips: [
      {
        id: 'themes',
        title: { fr: 'Thèmes et Theme Studio', en: 'Themes and Theme Studio' },
        body: {
          fr: 'Une trentaine de scènes animées, modifiables : palette, verre, scène, son. Un thème s\'exporte et s\'importe en JSON. Le contraste du texte est garanti lisible quelle que soit la palette.',
          en: 'Around thirty animated scenes, all editable: palette, glass, scene, sound. A theme exports and imports as JSON. Text contrast is kept readable whatever the palette.',
        },
        action: { settings: 'themes' },
      },
      {
        id: 'readability',
        title: { fr: 'Lisibilité d\'abord', en: 'Readability first' },
        body: {
          fr: 'Baissez la luminosité de la scène, élargissez ou resserrez la conversation, choisissez la police : tout est dans Réglages, Thèmes. Le mode zen (palette) cache tout sauf la conversation.',
          en: 'Lower the scene\'s brightness, widen or narrow the conversation, pick the font: all in Settings, Themes. Zen mode (palette) hides everything but the conversation.',
        },
        action: { settings: 'themes' },
      },
      {
        id: 'project-look',
        title: { fr: 'Reconnaître ses projets d\'un coup d\'œil', en: 'Recognize your projects at a glance' },
        body: {
          fr: 'Clic droit sur un projet, Personnaliser : une couleur, une icône ou votre propre image.',
          en: 'Right-click a project, Customize: a colour, an icon or your own picture.',
        },
      },
      {
        id: 'notifications',
        title: { fr: 'Être prévenu quand Claude a fini', en: 'Get told when Claude is done' },
        body: {
          fr: 'Une notification arrive quand une tâche se termine ou qu\'une question attend, seulement si vous regardez ailleurs. Cliquez dessus pour revenir sur l\'onglet.',
          en: 'A notification arrives when a task finishes or a question waits, only when you are looking elsewhere. Click it to go back to the tab.',
        },
      },
    ],
  },
];

module.exports = { CHAPTERS, DOCS };
