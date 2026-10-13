/** @jest-environment node */
/**
 * What the two pull request lookups the session Git tab relies on keep from
 * GitHub's answer. The tab's verdicts and labels are tested on objects shaped
 * like these; this pins the shape to the payload, with the network faked at
 * `https` and the token at keytar.
 */

'use strict';

const { EventEmitter } = require('events');

jest.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
jest.mock('keytar', () => ({ getPassword: jest.fn(async () => 'gho_test') }));
jest.mock('https', () => ({ request: jest.fn() }));

const https = require('https');
const { getPullRequest, getPullRequestsForBranch } = require('../../src/main/services/GitHubAuthService');

/** Answer the next request with `body`, as GitHub would. */
function answer(body, status = 200) {
  https.request.mockImplementationOnce((options, onResponse) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = {};
      res.resume = () => {};
      onResponse(res);
      res.emit('data', JSON.stringify(body));
      res.emit('end');
    };
    return req;
  });
}

const payload = (over = {}) => ({
  number: 68,
  title: 'Search: debounce the query',
  state: 'open',
  draft: false,
  html_url: 'https://github.com/acme/app/pull/68',
  head: { sha: 'abc123', ref: 'feat/search' },
  base: { ref: 'main' },
  merged_at: null,
  updated_at: '2026-10-13T10:00:00Z',
  mergeable_state: 'blocked',
  requested_reviewers: [{ login: 'grace' }],
  requested_teams: [{ name: 'Core', slug: 'core' }],
  labels: [{ name: 'enhancement', color: 'A2EEEF' }, { name: 'odd', color: 'red' }],
  ...over,
});

beforeEach(() => https.request.mockReset());

test('one pull request: mergeability, who is asked to review, labels, when it merged', async () => {
  answer(payload());
  const res = await getPullRequest('acme', 'app', 68);
  expect(res.pullRequest).toMatchObject({
    number: 68,
    state: 'open',
    headSha: 'abc123',
    headRef: 'feat/search',
    baseRef: 'main',
    mergeableState: 'blocked',
    requestedReviewers: ['grace', 'Core'],
    labels: [{ name: 'enhancement', color: 'a2eeef' }, { name: 'odd', color: null }],
    mergedAt: null,
  });
  expect(https.request.mock.calls[0][0].path).toBe('/repos/acme/app/pulls/68');
});

test('a merged one reads as merged, with its date', async () => {
  answer(payload({ state: 'closed', merged_at: '2026-10-13T08:00:00Z', mergeable_state: null }));
  const { pullRequest } = await getPullRequest('acme', 'app', 68);
  expect(pullRequest).toMatchObject({ state: 'merged', mergedAt: '2026-10-13T08:00:00Z', mergeableState: null });
});

test('by branch: the list carries the labels and reviewers, not the mergeability', async () => {
  const { mergeable_state: _omitted, ...listed } = payload();
  answer([listed]);
  const res = await getPullRequestsForBranch('acme', 'app', 'ada', 'feat/search');
  expect(res.pullRequests).toEqual([expect.objectContaining({
    number: 68,
    labels: [{ name: 'enhancement', color: 'a2eeef' }, { name: 'odd', color: null }],
    requestedReviewers: ['grace', 'Core'],
    mergedAt: null,
  })]);
  expect(res.pullRequests[0]).not.toHaveProperty('mergeableState');
});
