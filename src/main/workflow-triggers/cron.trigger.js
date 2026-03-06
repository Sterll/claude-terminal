'use strict';

/**
 * Vérifie si une expression cron matche la date donnée.
 * Implémentation simple sans dépendances externes.
 */
function cronMatches(expr, date) {
  if (!expr || expr === '* * * * *') return true;

  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const [minPart, hourPart, domPart, monPart, dowPart] = parts;

  function matchPart(part, value, min, max) {
    if (part === '*') return true;
    // Step: */n
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      return !isNaN(step) && value % step === 0;
    }
    // Range: n-m
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      return value >= lo && value <= hi;
    }
    // List: n,m,o
    if (part.includes(',')) {
      return part.split(',').map(Number).includes(value);
    }
    // Single number
    return parseInt(part, 10) === value;
  }

  const min = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1; // 1-12
  const dow = date.getDay(); // 0=Sunday

  return (
    matchPart(minPart,  min,  0, 59) &&
    matchPart(hourPart, hour, 0, 23) &&
    matchPart(domPart,  dom,  1, 31) &&
    matchPart(monPart,  mon,  1, 12) &&
    matchPart(dowPart,  dow,  0,  6)
  );
}

module.exports = {
  type:  'cron',
  label: 'Planifié',
  desc:  'Se déclenche selon une expression cron',

  shouldFire(config, _context) {
    return cronMatches(config.triggerValue, new Date());
  },

  setup(config, onFire) {
    const expr = config.triggerValue;
    if (!expr) return () => {};

    // Polling chaque minute (aligné sur l'horloge)
    let _timer = null;

    function scheduleNext() {
      const now = Date.now();
      const next = 60000 - (now % 60000) + 500; // prochaine minute + 500ms de marge
      _timer = setTimeout(() => {
        if (cronMatches(expr, new Date())) onFire();
        scheduleNext();
      }, next);
    }

    scheduleNext();

    return () => {
      if (_timer) clearTimeout(_timer);
    };
  },
};
