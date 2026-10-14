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
const { getPullRequest, getPullRequestsForBranch, getPullRequestReviews, getCheckRuns } = require('../../src/main/services/GitHubAuthService');

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

describe('pages', () => {
  const review = (id, user, state) => ({ id, user: { login: user }, state, body: '', submitted_at: '2026-10-13T10:00:00Z', html_url: `https://github.com/acme/app/pull/68#pullrequestreview-${id}` });

  test('reviews: every page, oldest first, until one is not full', async () => {
    answer(Array.from({ length: 100 }, (_, i) => review(i + 1, 'grace', 'CHANGES_REQUESTED')));
    answer([review(101, 'grace', 'APPROVED')]);
    const res = await getPullRequestReviews('acme', 'app', 68);
    expect(res.reviews).toHaveLength(101);
    expect(res.reviews[100]).toMatchObject({ id: 101, user: 'grace', state: 'APPROVED' });
    expect(https.request.mock.calls.map((c) => c[0].path)).toEqual([
      '/repos/acme/app/pulls/68/reviews?per_page=100&page=1',
      '/repos/acme/app/pulls/68/reviews?per_page=100&page=2',
    ]);
  });

  test('reviews: one page that is not full is the only request', async () => {
    answer([review(1, 'grace', 'APPROVED')]);
    const res = await getPullRequestReviews('acme', 'app', 68);
    expect(res).toEqual({ authenticated: true, reviews: [expect.objectContaining({ id: 1, state: 'APPROVED' })] });
    expect(https.request).toHaveBeenCalledTimes(1);
  });

  test('reviews: a page that fails fails the whole read, rather than give a partial verdict', async () => {
    answer(Array.from({ length: 100 }, (_, i) => review(i + 1, 'grace', 'CHANGES_REQUESTED')));
    answer({ message: 'Server Error' }, 502);
    expect(await getPullRequestReviews('acme', 'app', 68)).toEqual({ authenticated: true, reviews: [], error: 'API error: 502' });
  });

  test('check runs: a page of 100, not GitHub\'s 30', async () => {
    answer({ total_count: 1, check_runs: [{ id: 5, name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://ci', app: { slug: 'github-actions' } }] });
    const res = await getCheckRuns('acme', 'app', 'abc123');
    expect(res.checkRuns).toEqual([expect.objectContaining({ id: 5, app: 'github-actions' })]);
    expect(https.request.mock.calls[0][0].path).toBe('/repos/acme/app/commits/abc123/check-runs?per_page=100');
  });
});
