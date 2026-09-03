const { matchesSessionQuery, SESSION_ID_MIN_QUERY } = require('../../src/renderer/utils/sessionSearch');

const session = (overrides = {}) => ({
  searchText: 'flaky integration test on ci feat/find-session-by-id',
  sessionId: 'a3f9c210-4b7d-4e11-9c02-7fd8e6b41c55',
  ...overrides
});

describe('matchesSessionQuery', () => {
  test('an empty query matches every card', () => {
    expect(matchesSessionQuery(session(), '')).toBe(true);
  });

  test('a missing session never matches a non-empty query', () => {
    expect(matchesSessionQuery(undefined, 'flaky')).toBe(false);
  });

  test('matches on the free-text haystack', () => {
    expect(matchesSessionQuery(session(), 'flaky')).toBe(true);
    expect(matchesSessionQuery(session(), 'find-session')).toBe(true);
  });

  test('does not match text absent from the haystack', () => {
    expect(matchesSessionQuery(session(), 'kubernetes')).toBe(false);
  });

  test('a full session id finds its card', () => {
    expect(matchesSessionQuery(session(), 'a3f9c210-4b7d-4e11-9c02-7fd8e6b41c55')).toBe(true);
  });

  test('a prefix of a session id finds its card', () => {
    expect(matchesSessionQuery(session(), 'a3f9')).toBe(true);
    expect(matchesSessionQuery(session(), 'a3f9c210-4b7d')).toBe(true);
  });

  test('an id query is matched case-insensitively', () => {
    expect(matchesSessionQuery(session({ sessionId: 'A3F9C210-4B7D-4E11' }), 'a3f9')).toBe(true);
  });

  // The point of the length gate: short hex queries used to collide with roughly
  // one card in ten, because a session id carries 32 hex characters.
  test('a short hex query does not match an id it happens to contain', () => {
    expect(matchesSessionQuery(session(), 'f9c')).toBe(false);
    expect(matchesSessionQuery(session(), 'c2')).toBe(false);
  });

  test('an id fragment that is not a prefix does not match', () => {
    expect(matchesSessionQuery(session(), '7fd8e6b41c55')).toBe(false);
  });

  test('the gate sits at SESSION_ID_MIN_QUERY characters', () => {
    const id = 'abcdef01-2345-6789-abcd-ef0123456789';
    const s = session({ searchText: '', sessionId: id });
    const justUnder = id.slice(0, SESSION_ID_MIN_QUERY - 1);
    const atGate = id.slice(0, SESSION_ID_MIN_QUERY);
    expect(matchesSessionQuery(s, justUnder)).toBe(false);
    expect(matchesSessionQuery(s, atGate)).toBe(true);
  });

  test('a session with no id still matches on its text', () => {
    const s = { searchText: 'a session without an id' };
    expect(matchesSessionQuery(s, 'without')).toBe(true);
    expect(matchesSessionQuery(s, 'a3f9')).toBe(false);
  });
});
