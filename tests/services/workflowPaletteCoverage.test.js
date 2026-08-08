/**
 * Palette coverage guard.
 *
 * The editor palette used to be built from a hand-written STEP_TYPES list while
 * execution came from the main-process node registry. Eight node types shipped
 * with a working .node.js but no palette entry, so nobody could place them.
 *
 * buildPaletteEntries() merges both. This test fails the moment a new node
 * ships without becoming reachable.
 *
 * @jest-environment jsdom
 */

jest.mock('../../src/renderer/i18n', () => ({
  t: (k) => k,
  onLanguageChange: () => {},
  getCurrentLanguage: () => 'en',
}));

const registry = require('../../src/main/workflow-nodes/_registry');
const { buildPaletteEntries, STEP_TYPES } = require('../../src/renderer/ui/panels/WorkflowHelpers');

registry.loadRegistry();

/** The registry payload as it crosses IPC (workflow:get-node-registry). */
const registryDefs = registry.getAll().map(def => ({
  type: def.type, title: def.title, desc: def.desc, color: def.color,
  width: def.width || 200, category: def.category || 'actions', icon: def.icon || '',
  inputs: def.inputs || [], outputs: def.outputs || [], props: def.props || {},
}));

const executable = registryDefs
  .map(d => d.type.replace('workflow/', ''))
  .filter(t => t !== 'trigger')
  .sort();

describe('buildPaletteEntries', () => {
  const entries = buildPaletteEntries(registryDefs);
  const types = entries.map(e => e.type);

  it('lists every executable node type', () => {
    const missing = executable.filter(t => !types.includes(t));
    expect(missing).toEqual([]);
  });

  it('never lists the trigger, which the canvas creates on its own', () => {
    expect(types).not.toContain('trigger');
  });

  it('lists each type exactly once', () => {
    expect(types.length).toBe(new Set(types).size);
  });

  it('gives every entry the fields the palette renders', () => {
    for (const e of entries) {
      expect(typeof e.type).toBe('string');
      expect(typeof e.label).toBe('string');
      expect(e.label.length).toBeGreaterThan(0);
      expect(typeof e.color).toBe('string');
      expect(typeof e.icon).toBe('string');
      expect(e.icon).toMatch(/^<svg/);
      expect(['action', 'data', 'flow']).toContain(e.category);
    }
  });

  it('keeps the hand-written entry when both sources describe a type', () => {
    const claudeFromStep = STEP_TYPES.find(s => s.type === 'claude');
    const claudeInPalette = entries.find(e => e.type === 'claude');
    expect(claudeInPalette.label).toBe(claudeFromStep.label);
    expect(claudeInPalette._fromRegistry).toBeUndefined();
  });

  it('marks registry-derived entries so they can be told apart', () => {
    const retry = entries.find(e => e.type === 'retry');
    expect(retry).toBeDefined();
    expect(retry._fromRegistry).toBe(true);
  });

  it('normalises the registry "actions" category onto the palette "action" group', () => {
    const webhook = entries.find(e => e.type === 'webhook');
    expect(webhook.category).toBe('action');
  });

  it('degrades to the hand-written list when the registry is unavailable', () => {
    // The IPC call can fail (no preload bridge in some windows); the palette
    // must still render rather than throwing.
    const fallback = buildPaletteEntries([]);
    expect(fallback.length).toBeGreaterThan(0);
    expect(fallback.every(e => typeof e.label === 'string')).toBe(true);
  });
});
