/**
 * Which tickets belong to which session. The rules that matter: an explicit
 * link always wins, detection can only ever suggest a ticket the session has
 * never seen, a dismissal sticks against detection, and a tab's provisional
 * links follow it to its real session id.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIssueLinkService } = require('../../src/main/services/IssueLinkService');

let dir;
let storePath;
let broadcast;
let links;

const ENG142 = { ref: 'linear:ENG-142', connectionId: 'linear-1', title: 'Session tickets tab' };
const ENG155 = { ref: 'linear:ENG-155', connectionId: 'linear-1', title: 'Shared key prefixes' };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-issue-links-'));
  storePath = path.join(dir, 'issue-links.json');
  broadcast = jest.fn();
  links = createIssueLinkService({ storePath, broadcast, now: () => '2026-10-09T10:00:00.000Z' });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const statusOf = (list, ref) => list.find((l) => l.ref === ref)?.status;

test('an explicit link is stored with its source and broadcast', async () => {
  const list = await links.link('sess-1', { ...ENG142, source: 'manual' }, { projectId: 'p1' });
  expect(list).toEqual([{ ...ENG142, source: 'manual', evidence: null, status: 'linked', at: '2026-10-09T10:00:00.000Z' }]);
  expect(broadcast).toHaveBeenCalledWith('sess-1');
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  expect(stored.sessions['sess-1'].projectId).toBe('p1');
});

test('detection only suggests a ticket the session has never seen', async () => {
  expect(await links.suggest('sess-1', { ...ENG155, source: 'tool', evidence: 'save_issue' })).toBe(true);
  expect(await links.suggest('sess-1', { ...ENG155, source: 'pr' })).toBe(false);
  await links.link('sess-1', ENG142);
  expect(await links.suggest('sess-1', { ...ENG142, source: 'prompt' })).toBe(false);
  const list = await links.get('sess-1');
  expect(statusOf(list, ENG155.ref)).toBe('suggested');
  expect(list.find((l) => l.ref === ENG155.ref).evidence).toBe('save_issue');
});

test('confirm turns suggestions into links; dismiss sticks against detection', async () => {
  await links.suggest('sess-1', { ...ENG142, source: 'pr' });
  await links.suggest('sess-1', { ...ENG155, source: 'tool' });
  await links.confirm('sess-1', [ENG142.ref]);
  await links.dismiss('sess-1', [ENG155.ref]);
  let list = await links.get('sess-1');
  expect(statusOf(list, ENG142.ref)).toBe('linked');
  expect(statusOf(list, ENG155.ref)).toBe('dismissed');
  expect(await links.suggest('sess-1', { ...ENG155, source: 'tool' })).toBe(false);

  // Only an explicit link brings a dismissed ticket back.
  await links.link('sess-1', { ...ENG155, source: 'manual' });
  list = await links.get('sess-1');
  expect(statusOf(list, ENG155.ref)).toBe('linked');
});

test('confirm does not resurrect a dismissed ticket', async () => {
  await links.link('sess-1', ENG142);
  await links.dismiss('sess-1', ENG142.ref);
  await links.confirm('sess-1', [ENG142.ref]);
  expect(statusOf(await links.get('sess-1'), ENG142.ref)).toBe('dismissed');
});

test('a provisional tab key moves to the real session id, merging what was there', async () => {
  await links.link('tab:7', ENG142);
  await links.link('sess-real', ENG155);
  expect(await links.rekey('tab:7', 'sess-real')).toBe(true);
  expect(await links.get('tab:7')).toEqual([]);
  expect((await links.get('sess-real')).map((l) => l.ref).sort()).toEqual([ENG142.ref, ENG155.ref]);
  expect(broadcast).toHaveBeenLastCalledWith('sess-real');
});

test('a fork copies its parent\'s links, and the parent keeps them', async () => {
  await links.link('parent', ENG142);
  expect(await links.copy('parent', 'child')).toBe(true);
  await links.dismiss('child', ENG142.ref);
  expect(statusOf(await links.get('parent'), ENG142.ref)).toBe('linked');
  expect(statusOf(await links.get('child'), ENG142.ref)).toBe('dismissed');
  expect(await links.copy('parent', 'child')).toBe(false); // never overwrites a session
});

test('a fork already holding a detection gets its parent\'s links beside it', async () => {
  await links.link('parent', ENG142);
  await links.link('parent', ENG155);
  await links.suggest('child', { ...ENG155, source: 'tool' });
  expect(await links.copy('parent', 'child')).toBe(true);
  const list = await links.get('child');
  expect(statusOf(list, ENG142.ref)).toBe('linked');
  expect(statusOf(list, ENG155.ref)).toBe('suggested'); // the fork's own status is kept
});

test('a detection that finishes after the rekey lands on the real session id', async () => {
  // The tab moved before its first prompt's tracker lookup answered.
  expect(await links.rekey('tab:chat-1', 'sess-real')).toBe(false); // nothing stored yet, still remembered
  broadcast.mockClear();
  expect(await links.suggest('tab:chat-1', { ...ENG142, source: 'prompt' })).toBe(true);
  expect(statusOf(await links.get('sess-real'), ENG142.ref)).toBe('suggested');
  expect(broadcast).toHaveBeenCalledWith('sess-real');
  expect(broadcast).not.toHaveBeenCalledWith('tab:chat-1');
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  expect(stored.sessions['tab:chat-1']).toBeUndefined(); // no orphan entry
});

test('a write queued before the rekey is moved with the rest', async () => {
  const pending = links.suggest('tab:chat-2', { ...ENG142, source: 'prompt' });
  await links.rekey('tab:chat-2', 'sess-two');
  await pending;
  expect(statusOf(await links.get('sess-two'), ENG142.ref)).toBe('suggested');
  expect(JSON.parse(fs.readFileSync(storePath, 'utf8')).sessions['tab:chat-2']).toBeUndefined();
});

test('a provisional entry that never moved is dropped after a week', async () => {
  fs.writeFileSync(storePath, JSON.stringify({
    version: 1,
    sessions: {
      'tab:old': { links: [{ ...ENG142, status: 'linked' }], updatedAt: '2026-09-01T00:00:00.000Z' },
      'tab:recent': { links: [{ ...ENG142, status: 'linked' }], updatedAt: '2026-10-08T00:00:00.000Z' },
      'sess-old': { links: [{ ...ENG142, status: 'linked' }], updatedAt: '2026-01-01T00:00:00.000Z' },
    },
  }));
  await links.link('sess-1', ENG155);
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  expect(Object.keys(stored.sessions).sort()).toEqual(['sess-1', 'sess-old', 'tab:recent']);
});

test('every write keeps the previous file as .bak', async () => {
  await links.link('sess-1', ENG142);
  expect(fs.existsSync(`${storePath}.bak`)).toBe(false); // nothing to back up on the first write
  await links.link('sess-1', ENG155);
  const backup = JSON.parse(fs.readFileSync(`${storePath}.bak`, 'utf8'));
  expect(backup.sessions['sess-1'].links.map((l) => l.ref)).toEqual([ENG142.ref]);
});

test('counts are per ticket, linked only', async () => {
  await links.link('a', ENG142);
  await links.link('b', ENG142);
  await links.suggest('c', ENG142);
  await links.link('c', ENG155);
  await links.dismiss('c', ENG155.ref);
  expect(await links.counts()).toEqual({ [ENG142.ref]: 2 });
});

test('bad keys and bad refs are refused', async () => {
  await expect(links.link('has space', ENG142)).rejects.toThrow('Invalid session key');
  await expect(links.link('sess-1', { ref: 'ENG-142' })).rejects.toThrow('Invalid ticket reference');
  expect(await links.get('../etc')).toEqual([]);
});

test('an unreadable store is refused, never reset', async () => {
  fs.writeFileSync(storePath, '{"version":1,"sessions":{"a":');
  await expect(links.link('sess-1', ENG142)).rejects.toThrow(/Refusing to modify issue-links\.json/);
  expect(fs.readFileSync(storePath, 'utf8')).toBe('{"version":1,"sessions":{"a":');
  expect(broadcast).not.toHaveBeenCalled();
});

test('concurrent writes to one session keep every link', async () => {
  await Promise.all([links.link('s', ENG142), links.link('s', ENG155), links.suggest('s', { ref: 'linear:ENG-1' })]);
  expect((await links.get('s')).map((l) => l.ref).sort()).toEqual(['linear:ENG-1', ENG142.ref, ENG155.ref]);
});
