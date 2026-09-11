/**
 * The registry after the identity/behaviour split.
 *
 * `discoverAll()` used to require() all seven types, which is what put 362 KB of
 * dashboards, wizards and terminal panels in the startup bundle for everyone. It
 * now registers seven identities — `<type>/meta.js` — and fetches a type's
 * behaviour only when something needs it.
 *
 * Two properties matter and both are pinned here:
 *
 *   1. Identity is complete and synchronous. The new-project wizard and the
 *      sidebar draw from it at boot, so a type must have its id, name key,
 *      category and icon before anything is loaded.
 *   2. A type whose behaviour never arrives is inert, not broken. Every hook
 *      falls back to the BASE_TYPE no-op, and no caller sees a throw.
 *
 * Property 2 is exercised for real rather than mocked: dynamic import() is
 * unavailable under Jest without --experimental-vm-modules, so every
 * `ensureLoaded()` in this file takes the failure path. That is the same path a
 * missing or corrupt chunk takes in the app.
 */

const registry = require('../../src/project-types/registry');

const BUILTIN_IDS = ['standalone', 'fivem', 'webapp', 'python', 'api', 'minecraft', 'discord'];

beforeEach(() => {
  registry.discoverAll();
});

describe('discoverAll', () => {
  it('registers every built-in', () => {
    expect(registry.getAll().map(t => t.id).sort()).toEqual([...BUILTIN_IDS].sort());
  });

  it('gives each one a complete identity without loading anything', () => {
    for (const type of registry.getAll()) {
      expect(typeof type.nameKey).toBe('string');
      expect(type.nameKey).not.toBe('');
      expect(typeof type.descKey).toBe('string');
      expect(type.icon).toMatch(/^<svg/);
      expect(['general', 'bots', 'gamedev']).toContain(type.category);
    }
  });

  it('groups them into the wizard categories', () => {
    const grouped = registry.getByCategory();
    const ids = grouped.flatMap(g => g.types.map(t => t.id));

    // The wizard draws from this at boot, before any behaviour exists.
    expect(ids.sort()).toEqual([...BUILTIN_IDS].sort());
  });

  it('reports the general type as loaded and the rest as not', () => {
    // general/index.js is identity and nothing else, so it has no second half.
    expect(registry.isLoaded('standalone')).toBe(true);
    for (const id of BUILTIN_IDS.filter(i => i !== 'standalone')) {
      expect(registry.isLoaded(id)).toBe(false);
    }
  });
});

describe('an unloaded type', () => {
  it('answers every behaviour hook with the base no-op', () => {
    const fivem = registry.get('fivem');

    expect(fivem.getSidebarButtons({})).toBe('');
    expect(fivem.getMenuItems({})).toBe('');
    expect(fivem.getStatusIndicator({})).toBe('');
    expect(fivem.getConsoleConfig(null, 0)).toBeNull();
    expect(fivem.getTerminalPanels({})).toEqual([]);
    expect(fivem.getSettingsFields()).toEqual([]);
    expect(fivem.getTranslations()).toBeNull();
    expect(fivem.getStyles()).toBeNull();
  });

  it('still resolves by id rather than falling back to standalone', () => {
    expect(registry.get('discord').id).toBe('discord');
  });
});

describe('ensureLoaded', () => {
  it('is a resolved no-op for a type that has no behaviour half', async () => {
    await expect(registry.ensureLoaded('standalone')).resolves.toBe(true);
  });

  it('reports failure without throwing when the chunk will not load', async () => {
    await expect(registry.ensureLoaded('fivem')).resolves.toBe(false);
  });

  it('leaves the type usable after a failed load', async () => {
    await registry.ensureLoaded('fivem');

    const fivem = registry.get('fivem');
    expect(fivem.id).toBe('fivem');
    expect(fivem.nameKey).toBe('newProject.types.fivem');
    expect(() => fivem.getSidebarButtons({})).not.toThrow();
    expect(registry.isLoaded('fivem')).toBe(false);
  });

  it('answers false for an id no built-in loader owns', async () => {
    await expect(registry.ensureLoaded('rust')).resolves.toBe(false);
  });
});

describe('ensureLoadedMany', () => {
  it('resolves to an empty list when there is nothing new to fetch', async () => {
    await expect(registry.ensureLoadedMany(['standalone', 'standalone'])).resolves.toEqual([]);
  });

  it('ignores ids nothing can load, so a watcher does not retry them forever', async () => {
    // A type string from a projects.json this build does not know, and an
    // external type, which owns its own descriptor and has no chunk.
    await expect(registry.ensureLoadedMany(['rust', 'ext-go', null, undefined])).resolves.toEqual([]);
  });

  it('reports nothing loaded when every chunk fails', async () => {
    await expect(registry.ensureLoadedMany(['fivem', 'discord'])).resolves.toEqual([]);
  });
});

describe('ensureAllLoaded', () => {
  it('never rejects, whatever the chunks do', async () => {
    await expect(registry.ensureAllLoaded()).resolves.toEqual([]);
  });
});

describe('discoverAll again', () => {
  it('clears what an earlier run had loaded', async () => {
    await registry.ensureLoaded('fivem');
    registry.discoverAll();

    expect(registry.isLoaded('fivem')).toBe(false);
    expect(registry.getAll()).toHaveLength(BUILTIN_IDS.length);
  });
});

describe('identity and behaviour do not drift', () => {
  it('each index.js takes its identity from its own meta.js', () => {
    // The split only stays honest if there is one source of truth: index.js
    // spreads meta.js rather than restating the five fields next to it.
    for (const dir of ['general', 'fivem', 'webapp', 'python', 'api', 'minecraft', 'discord']) {
      const meta = require(`../../src/project-types/${dir}/meta`);
      const type = require(`../../src/project-types/${dir}`);

      expect(type.id).toBe(meta.id);
      expect(type.nameKey).toBe(meta.nameKey);
      expect(type.descKey).toBe(meta.descKey);
      expect(type.category).toBe(meta.category);
      expect(type.icon).toBe(meta.icon);
    }
  });

  it('registers each type under the id its own meta declares', () => {
    for (const dir of ['fivem', 'webapp', 'python', 'api', 'minecraft', 'discord']) {
      const meta = require(`../../src/project-types/${dir}/meta`);
      expect(registry.get(meta.id).id).toBe(meta.id);
    }
  });
});
