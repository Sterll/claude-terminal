/**
 * Claude Terminal Remote — Lightweight i18n module
 * Supports FR/EN/ES with auto-detection, persistence, and DOM integration.
 */

const SUPPORTED_LANGS = ['fr', 'en', 'es'];
const DEFAULT_LANG = 'en';

const TRANSLATIONS = {
  fr: {
    // Auth
    'pin.message': 'Entrez le code affiché dans\nParamètres \u2192 Télécommande',
    'pin.error': 'Code invalide ou expiré. Réessayez.',
    'pin.connFail': 'Connexion impossible. Le serveur est-il démarré ?',
    'cloud.enterKey': 'Entrez votre clé API',
    'cloud.keyError': 'Connexion échouée. Vérifiez votre clé API.',
    'cloud.switchBtn': 'Mode cloud',
    'cloud.pinModeBtn': 'Mode PIN (LAN)',

    // Navigation
    'nav.projects': 'Projets',
    'nav.chat': 'Chat',
    'nav.dashboard': 'Dashboard',
    'nav.control': 'Contrôle',
    'nav.tabs': 'Onglets',
    'nav.git': 'Git',

    // Sessions
    'session.new': 'Nouveau chat',
    'session.newHint': 'Écrivez un message pour commencer',
    'session.noChats': 'Aucun chat',
    'session.noChatsHint': 'Cliquez le bouton ci-dessous pour commencer',
    'session.pastDivider': 'Sessions précédentes',
    'session.showMore': 'Voir {count} de plus\u2026',

    // Status
    'status.reconnecting': 'Reconnexion\u2026',
    'status.connected': 'Connecté',
    'status.disconnected': 'Déconnecté',
    'status.thinking': 'Réflexion\u2026',
    'status.noOutput': '(aucune sortie)',
    'status.active': 'Actif',
    'status.idle': 'Inactif',
    'status.error': 'Erreur',
    'status.permission': 'Permission',
    'status.claudeWorking': 'Claude travaille\u2026',
    'status.done': 'Terminé',
    'status.claudeFinished': 'Claude a terminé',
    'status.claudeError': 'Erreur Claude',
    'status.permRequired': 'Permission requise',
    'status.permPrefix': 'Permission :',

    // Headless / Cloud
    'headless.banner': 'PC hors ligne \u2014 Session cloud disponible',
    'headless.bannerActive': 'Session cloud active',
    'headless.creating': 'Lancement session cloud\u2026',
    'headless.error': 'Erreur session cloud',
    'headless.selectProject': 'Sélectionnez un projet pour démarrer',
    'cloud.popupTitle': 'Travaillez dans le cloud',
    'cloud.popupDesc': 'Votre PC est hors ligne. Continuez à travailler avec des sessions cloud directement sur le serveur.',
    'cloud.popupCta': 'Passer en mode cloud',

    // Projects
    'project.noProjects': 'Aucun projet.',
    'project.noProjectsDash': 'Aucun projet',

    // Dashboard
    'dashboard.timeToday': 'Temps aujourd\'hui',
    'dashboard.activeProject': 'Projet actif',
    'dashboard.sessions': 'Sessions',
    'dashboard.projectsSection': 'Projets',

    // Git
    'git.loading': 'Chargement\u2026',
    'git.notRepo': 'Pas un dépôt Git',
    'git.upToDate': 'À jour',
    'git.changes': 'Changements',
    'git.clean': 'Working tree propre',
    'git.recentCommits': 'Commits récents',
    'git.pull': 'Pull',
    'git.push': 'Push',

    // Mentions
    'mention.file': 'Joindre un fichier',
    'mention.git': 'Changements git',
    'mention.terminal': 'Sortie du terminal',
    'mention.errors': 'Erreurs du terminal',
    'mention.todos': 'TODO/FIXME du projet',

    // Slash commands
    'slash.compact': 'Compacter l\'historique',
    'slash.clear': 'Effacer la conversation',
    'slash.help': 'Aide',

    // Chat
    'chat.imageAttached': '(image jointe)',
    'chat.noFiles': 'Aucun fichier trouvé',

    // Misc
    'misc.allow': 'Autoriser',
    'misc.deny': 'Refuser',
    'misc.loading': 'Chargement\u2026',
    'misc.disconnectedAdmin': 'Déconnecté par l\'administrateur',
    'misc.tooManyMobile': 'Trop de mobiles connectés',
    'misc.desktopOffline': 'PC hors ligne',
    'misc.justNow': 'à l\'instant',
    'misc.camera': 'Caméra',
    'misc.gallery': 'Galerie',
    'misc.model': 'Modèle',
    'misc.thinking': 'Réflexion',
    'misc.noDetails': 'Aucun détail disponible',

    // PWA
    'pwa.addHome': 'Ajouter à l\'écran d\'accueil',
    'pwa.install': 'Installer',

    // Control
    'control.noSessions': 'Aucune session active',
    'control.title': 'Mission Control',
  },

  en: {
    'pin.message': 'Enter the 6-digit PIN shown in\nSettings \u2192 Remote Control',
    'pin.error': 'Invalid or expired PIN. Try again.',
    'pin.connFail': 'Connection failed. Is the server running?',
    'cloud.enterKey': 'Enter your API key',
    'cloud.keyError': 'Connection failed. Check your API key.',
    'cloud.switchBtn': 'Cloud mode',
    'cloud.pinModeBtn': 'PIN mode (LAN)',

    'nav.projects': 'Projects',
    'nav.chat': 'Chat',
    'nav.dashboard': 'Dashboard',
    'nav.control': 'Control',
    'nav.tabs': 'Tabs',
    'nav.git': 'Git',

    'session.new': 'New chat',
    'session.newHint': 'Type a message to get started',
    'session.noChats': 'No chats yet',
    'session.noChatsHint': 'Tap the button below to get started',
    'session.pastDivider': 'Past sessions',
    'session.showMore': 'Show {count} more\u2026',

    'status.reconnecting': 'Reconnecting\u2026',
    'status.connected': 'Connected',
    'status.disconnected': 'Disconnected',
    'status.thinking': 'Thinking\u2026',
    'status.noOutput': '(no output)',
    'status.active': 'Active',
    'status.idle': 'Idle',
    'status.error': 'Error',
    'status.permission': 'Permission',
    'status.claudeWorking': 'Claude is working\u2026',
    'status.done': 'Done',
    'status.claudeFinished': 'Claude finished',
    'status.claudeError': 'Claude error',
    'status.permRequired': 'Permission required',
    'status.permPrefix': 'Permission:',

    'headless.banner': 'Desktop offline \u2014 Cloud mode available',
    'headless.bannerActive': 'Cloud session active',
    'headless.creating': 'Starting cloud session\u2026',
    'headless.error': 'Cloud session error',
    'headless.selectProject': 'Select a project to start',
    'cloud.popupTitle': 'Work in the cloud',
    'cloud.popupDesc': 'Your PC is offline. Continue working with cloud sessions directly on the server.',
    'cloud.popupCta': 'Switch to cloud',

    'project.noProjects': 'No projects yet.',
    'project.noProjectsDash': 'No projects yet',

    'dashboard.timeToday': 'Time today',
    'dashboard.activeProject': 'Active project',
    'dashboard.sessions': 'Sessions',
    'dashboard.projectsSection': 'Projects',

    'git.loading': 'Loading\u2026',
    'git.notRepo': 'Not a Git repository',
    'git.upToDate': 'Up to date',
    'git.changes': 'Changes',
    'git.clean': 'Working tree clean',
    'git.recentCommits': 'Recent commits',
    'git.pull': 'Pull',
    'git.push': 'Push',

    'mention.file': 'Attach a file',
    'mention.git': 'Git changes',
    'mention.terminal': 'Terminal output',
    'mention.errors': 'Terminal errors',
    'mention.todos': 'Project TODO/FIXME',

    'slash.compact': 'Compact conversation',
    'slash.clear': 'Clear conversation',
    'slash.help': 'Show help',

    'chat.imageAttached': '(image attached)',
    'chat.noFiles': 'No files found',

    'misc.allow': 'Allow',
    'misc.deny': 'Deny',
    'misc.loading': 'Loading\u2026',
    'misc.disconnectedAdmin': 'Disconnected by administrator',
    'misc.tooManyMobile': 'Too many mobile connections',
    'misc.desktopOffline': 'Desktop offline',
    'misc.justNow': 'just now',
    'misc.camera': 'Camera',
    'misc.gallery': 'Gallery',
    'misc.model': 'Model',
    'misc.thinking': 'Thinking',
    'misc.noDetails': 'No details available',

    'pwa.addHome': 'Add to your home screen',
    'pwa.install': 'Install',

    'control.noSessions': 'No active sessions',
    'control.title': 'Mission Control',
  },

  es: {
    'pin.message': 'Ingrese el PIN de 6 d\u00edgitos que aparece en\nAjustes \u2192 Control Remoto',
    'pin.error': 'PIN inv\u00e1lido o expirado. Intente de nuevo.',
    'pin.connFail': 'Conexi\u00f3n fallida. \u00bfEst\u00e1 el servidor iniciado?',
    'cloud.enterKey': 'Ingrese su clave API',
    'cloud.keyError': 'Conexi\u00f3n fallida. Verifique su clave API.',
    'cloud.switchBtn': 'Modo cloud',
    'cloud.pinModeBtn': 'Modo PIN (LAN)',

    'nav.projects': 'Proyectos',
    'nav.chat': 'Chat',
    'nav.dashboard': 'Dashboard',
    'nav.control': 'Control',
    'nav.tabs': 'Pesta\u00f1as',
    'nav.git': 'Git',

    'session.new': 'Nuevo chat',
    'session.newHint': 'Escribe un mensaje para comenzar',
    'session.noChats': 'Sin chats a\u00fan',
    'session.noChatsHint': 'Toca el bot\u00f3n de abajo para comenzar',
    'session.pastDivider': 'Sesiones anteriores',
    'session.showMore': 'Ver {count} m\u00e1s\u2026',

    'status.reconnecting': 'Reconectando\u2026',
    'status.connected': 'Conectado',
    'status.disconnected': 'Desconectado',
    'status.thinking': 'Pensando\u2026',
    'status.noOutput': '(sin salida)',
    'status.active': 'Activo',
    'status.idle': 'Inactivo',
    'status.error': 'Error',
    'status.permission': 'Permiso',
    'status.claudeWorking': 'Claude est\u00e1 trabajando\u2026',
    'status.done': 'Terminado',
    'status.claudeFinished': 'Claude termin\u00f3',
    'status.claudeError': 'Error de Claude',
    'status.permRequired': 'Permiso requerido',
    'status.permPrefix': 'Permiso:',

    'headless.banner': 'PC sin conexi\u00f3n \u2014 Modo cloud disponible',
    'headless.bannerActive': 'Sesi\u00f3n cloud activa',
    'headless.creating': 'Iniciando sesi\u00f3n cloud\u2026',
    'headless.error': 'Error de sesi\u00f3n cloud',
    'headless.selectProject': 'Seleccione un proyecto para comenzar',
    'cloud.popupTitle': 'Trabaja en la nube',
    'cloud.popupDesc': 'Tu PC est\u00e1 sin conexi\u00f3n. Contin\u00faa trabajando con sesiones cloud directamente en el servidor.',
    'cloud.popupCta': 'Cambiar a cloud',

    'project.noProjects': 'Sin proyectos a\u00fan.',
    'project.noProjectsDash': 'Sin proyectos a\u00fan',

    'dashboard.timeToday': 'Tiempo hoy',
    'dashboard.activeProject': 'Proyecto activo',
    'dashboard.sessions': 'Sesiones',
    'dashboard.projectsSection': 'Proyectos',

    'git.loading': 'Cargando\u2026',
    'git.notRepo': 'No es un repositorio Git',
    'git.upToDate': 'Al d\u00eda',
    'git.changes': 'Cambios',
    'git.clean': 'Working tree limpio',
    'git.recentCommits': 'Commits recientes',
    'git.pull': 'Pull',
    'git.push': 'Push',

    'mention.file': 'Adjuntar un archivo',
    'mention.git': 'Cambios git',
    'mention.terminal': 'Salida del terminal',
    'mention.errors': 'Errores del terminal',
    'mention.todos': 'TODO/FIXME del proyecto',

    'slash.compact': 'Compactar conversaci\u00f3n',
    'slash.clear': 'Borrar conversaci\u00f3n',
    'slash.help': 'Ayuda',

    'chat.imageAttached': '(imagen adjunta)',
    'chat.noFiles': 'Ning\u00fan archivo encontrado',

    'misc.allow': 'Permitir',
    'misc.deny': 'Rechazar',
    'misc.loading': 'Cargando\u2026',
    'misc.disconnectedAdmin': 'Desconectado por el administrador',
    'misc.tooManyMobile': 'Demasiados m\u00f3viles conectados',
    'misc.desktopOffline': 'PC sin conexi\u00f3n',
    'misc.justNow': 'ahora mismo',
    'misc.camera': 'C\u00e1mara',
    'misc.gallery': 'Galer\u00eda',
    'misc.model': 'Modelo',
    'misc.thinking': 'Pensamiento',
    'misc.noDetails': 'Sin detalles disponibles',

    'pwa.addHome': 'A\u00f1adir a la pantalla de inicio',
    'pwa.install': 'Instalar',

    'control.noSessions': 'Sin sesiones activas',
    'control.title': 'Mission Control',
  },
};

// ─── State ───────────────────────────────────────────────────────────────────

let _currentLang = DEFAULT_LANG;

function _detectLang() {
  try {
    const saved = localStorage.getItem('ct-remote-lang');
    if (saved && SUPPORTED_LANGS.includes(saved)) return saved;
  } catch (_) {}
  try {
    const code = (navigator.language || '').split('-')[0].toLowerCase();
    if (SUPPORTED_LANGS.includes(code)) return code;
  } catch (_) {}
  return DEFAULT_LANG;
}

_currentLang = _detectLang();

// ─── Public API ──────────────────────────────────────────────────────────────

function t(key, params) {
  const val = TRANSLATIONS[_currentLang]?.[key] || TRANSLATIONS[DEFAULT_LANG]?.[key] || key;
  if (!params) return val;
  return val.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? params[k] : `{${k}}`));
}

function setLang(code) {
  if (!SUPPORTED_LANGS.includes(code)) return;
  _currentLang = code;
  try { localStorage.setItem('ct-remote-lang', code); } catch (_) {}
  applyDOM();
}

function getLang() {
  return _currentLang;
}

function applyDOM() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.placeholder = t(key);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    if (key) el.innerHTML = t(key);
  });
}

// ─── Export as global ────────────────────────────────────────────────────────

window.i18n = { t, setLang, getLang, applyDOM, SUPPORTED_LANGS };
