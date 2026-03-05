const { generateSessionRecapHeuristic } = require('../../src/main/utils/commitMessageGenerator');

describe('generateSessionRecapHeuristic', () => {
  test('formats tool counts sorted by frequency', () => {
    const ctx = { toolCounts: { Write: 4, Edit: 3, Bash: 1 }, toolCount: 8, prompts: [] };
    const result = generateSessionRecapHeuristic(ctx);
    expect(result).toBe('Write ×4, Edit ×3, Bash ×1');
  });

  test('limits to 4 tools', () => {
    const ctx = { toolCounts: { Write: 5, Edit: 4, Bash: 3, Read: 2, Glob: 1 }, toolCount: 15 };
    const result = generateSessionRecapHeuristic(ctx);
    expect(result).not.toContain('Glob');
    expect(result.split(',').length).toBe(4);
  });

  test('falls back to tool count when no toolCounts', () => {
    const ctx = { toolCounts: {}, toolCount: 5, prompts: [] };
    const result = generateSessionRecapHeuristic(ctx);
    expect(result).toBe('5 tool uses');
  });

  test('handles empty context gracefully', () => {
    const result = generateSessionRecapHeuristic({});
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
