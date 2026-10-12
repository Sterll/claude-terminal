# Issue trackers: a provider-neutral ticket layer

**Status:** the core and every surface are in, tested against the fake adapter. No provider is registered yet: the first one, Linear, comes in its own pull request (see *Delivery*). Until then Settings → Tickets says no tracker is available.
**Scope:** `src/shared/issue-trackers.js`, `src/main/issue-trackers/`, the Tickets screen and the per-session Tickets tab.
**Audience:** anyone writing an adapter for a new provider, and anyone about to change the contract.

---

## What it is for

Three surfaces, one data layer:

1. **A Tickets screen** in the sidebar, under Git. Every ticket of the workspace, as a list or a Kanban board, with filters.
2. **A Tickets tab in each session**, beside Conversation, Changes and Documents. Only the tickets linked to that session, with their live status.
3. **A Git tab in each session**: branch, commits, pull request, checks and reviews. It sits next to Changes and does not replace it: Changes is what Claude edited, Git is where the branch stands.

Linear is the first provider. The core does not know that: a provider is an **adapter**, one file, and adding Jira, GitHub Issues or GitLab means adding a file, not touching the screens.

---

## Decisions

| Decision | Why |
|----------|-----|
| An adapter is a file in this repository, `src/main/issue-trackers/<id>.tracker.js`, found by `_registry.js`. | Same reasoning as `design/project-type-extensions.md`: an adapter holds a credential and talks to the network from the main process. Review is the gate, so adapters arrive by pull request, never as code loaded at runtime. |
| Everything an adapter returns goes through the sanitisers in `src/shared/issue-trackers.js`. | Adapter output is untrusted text on its way to the DOM. Colours land in a `style` attribute, URLs in an `href` and in `openExternal`. Validating once beats trusting every view to remember. |
| The credential is a personal API key, one per connection, in the OS credential store (keytar). | Like the Groq key in `VoiceService`: never in `settings.json`, never sent to the renderer. OAuth can come later as a second `auth.type`. |
| All provider calls are made by the main process. | The renderer CSP keeps its `connect-src` list as it is, and the key never crosses the bridge. |
| The Tickets screen covers the whole workspace. | No project-to-team binding for now. Filters do the narrowing. |
| The sidebar entry is always called **Tickets**. | Whatever the provider, and however many are connected. |
| A ticket is identified by `provider:key` (`linear:ENG-142`). | Linear and Jira both use `ENG-142`. The provider id is what keeps them apart in links and caches. |
| Explicit actions link a ticket to a session at once. Automatic detection only **suggests**, and the user confirms in the chat. | "Link" button, `@ENG-142` mention and "Start a session" are the user's own act. A tool call, a branch name, a PR title or a key typed in a prompt is a guess, so it becomes a suggestion card at the end of the turn. The card is not sent to Claude. |
| No webhooks. The app polls while a ticket view is visible, asking only for what changed since the last poll. | A desktop app has no public URL. The cloud relay could host webhooks later. |

---

## The contract

An adapter module exports one object:

```js
module.exports = {
  id: 'linear',                     // lower-case, 2 to 32 chars, the prefix of every ref
  name: 'Linear',                   // proper noun, not translated
  auth: { type: 'apiKey', helpUrl: 'https://linear.app/settings/account/security' },
  capabilities: {
    priority: true,                 // false: every issue reports priority null
    labels: true,
    estimate: true,
    comments: true,
    write: ['state', 'assignee', 'priority', 'comment'],  // empty: read-only
  },
  createClient({ secret, fetch }) { /* returns the client, does no I/O */ },
  refs: {
    fromText(text, knownKeys) { /* -> ['ENG-142'] */ },
    fromToolCall({ name, input, result }) { /* -> [{ key, action }] (optional) */ },
  },
};
```

The client:

| Method | Returns | Required |
|--------|---------|----------|
| `whoAmI()` | `{ user, workspace: { id, name, url? } }` | always |
| `metadata()` | `{ keys, people, states, labels, facets }` | always |
| `listIssues(query, cursor)` | `{ issues, next }`, `next` an opaque string or null | always |
| `getIssue(key)` | issue + `description`, `comments`, `children` | always |
| `updateIssue(key, patch)` | the updated issue | when `write` has `state`, `assignee` or `priority` |
| `addComment(key, body)` | the comment | when `write` has `comment` |

Every method is async. Failures reject with an `Error` whose `code` is one of `AUTH`, `RATE_LIMITED` (with `retryAfterMs` when known), `NOT_FOUND`, `NETWORK` or `PROVIDER`; build them with `trackerError()` from `_contract.js`. The UI branches on the code: `AUTH` asks for a new key, `RATE_LIMITED` waits, `NOT_FOUND` shows the ticket as gone without unlinking it. Messages are in English, like every main-process error.

`metadata()` is fetched once per connection and cached. It holds what the filter bar and the board need:

- `keys`: the prefixes `fromText` accepts (`['ENG', 'OPS']`). Empty for a tracker whose references have no prefix.
- `people`, `labels`: filter options.
- `states`: every workflow state, each with a **category**. These are the board's columns when it shows a single team.
- `facets`: provider-specific filters, described rather than coded: `{ id, label, multi, options: [{ value, label, color? }] }`. The filter bar draws them without knowing what they are. Reuse a common id (`team`, `project`, `cycle`, `sprint`, `milestone`, `epic`, `repository`) when the concept matches, so the UI's translation of that id applies.

---

## The normalised model

```js
{
  ref: 'linear:ENG-142', provider: 'linear', key: 'ENG-142', id,  // id: the provider's internal id, if any
  title, url,                                    // url: https only
  state: { id, name, color, category },          // category: backlog | todo | started | done | canceled
  priority,                                      // 0 none, 1 urgent, 2 high, 3 medium, 4 low; null when unsupported
  assignee: { id, name, avatarUrl } | null,
  labels: [{ id, name, color }],
  container: { id, name } | null,                // Linear team, Jira project, GitHub repository
  facets: { cycle: 'Cycle 42' },                 // display values of the declared facets
  estimate, dueDate, branchName, createdAt, updatedAt,
  parent: { ref, key, title, url, state, subIssues } | null,  // enough to draw the parent above its sub-issues
  subIssues: { total, done } | null,             // done: closed (done or canceled); null when it has none
}
```

- **State categories** are what makes a board across several teams possible: each team has its own states, but every state belongs to one of five categories. Linear calls them state types, Jira status categories, GitHub has only open (`todo`) and closed (`done`).
- **Hierarchy** travels with each issue: its `parent` (key, title, state and that parent's own progress) and its own `subIssues` count. A list nests a sub-issue under its parent when both are listed, and otherwise draws the parent from what the child carries, dimmed, as Linear does; no extra request is needed to show where a ticket belongs. `subIssues` counts every sub-issue the tracker has, not only the listed ones, so an adapter may need a second, cheap request to fill it.
- **Priority** follows Linear's scale. A provider with no priorities reports `null`, never `0`: "no priority set" and "this tracker has no priorities" are different facts for the filter bar.

A **query** (`normalizeQuery()`) is the only thing an adapter receives: `text`, `mine` (`assigned`, `created`, `subscribed`), `stateCategories`, `stateIds`, `assigneeIds` (with the special values `me` and `none`), `priorities`, `labelIds`, `facets`, `updatedSince`, `sort` and `limit`. Unknown values are dropped rather than rejected, so a saved filter from an older build degrades to "no filter" instead of to an error.

Clauses combine with AND, except `stateCategories` and `stateIds`: together they are the one "Status" filter, and a state matches if its category **or** its id is selected. The filter bar offers whole categories and individual states in a single menu, and "To do, plus In Review" must not come back empty. Adapters only have to honour `sort: 'updated'` and `'created'` on the server; `'priority'` and `'due'` may be applied to the returned page.

---

## Detecting tickets

`refs.fromText(text, knownKeys)` finds references in a branch name, a PR title or a prompt. For `PREFIX-123` trackers, use `extractKeyedRefs()` from the shared module: it is case-insensitive (branch names are lower case), accepts `feat_ENG-142`, and returns nothing for a prefix the tracker does not have. That last rule is the important one, because without it UTF-8, ISO-8601 and SHA-256 become tickets.

`refs.fromToolCall({ name, input, result })` reads Claude's calls to the provider's own MCP tools. It returns the tickets a call **targets** (`read` or `write`) or **creates** (`create`, key read from the result), and never the content of a list: a `list_issues` call returns dozens of tickets, and none of them is being worked on.

Where detection looks (`IssueDetectionService`):

| Source | Signal |
|--------|--------|
| Tool call | a provider MCP tool targets or creates a ticket |
| Prompt | a key typed by the user (Claude's own text is ignored, too noisy) |
| Branch | the session's branch name contains a key |
| Pull request | the title of the PR for the session's branch contains a key |

Chat sessions are read from ChatService's event stream, terminal sessions from the `PostToolUse` and `UserPromptSubmit` hooks. A key is only suggested once the tracker confirms the ticket exists. Suggestions from one moment are gathered into one card, shown at the end of a turn, never in the middle of Claude's answer; a card left unanswered changes nothing, the suggestions stay listed in the session's Tickets tab.

Two connections of the same provider that both have a ticket with the same key collide on one ref (`linear:ENG-142`); the first connection that confirms the ticket wins. Rare enough to leave for now.

---

## Writing an adapter

1. Add `src/main/issue-trackers/<id>.tracker.js`. Use the `fetch` handed to `createClient`, never the global one.
2. Add `tests/issue-trackers/fixtures/<id>.fixture.js`: `{ secret, fetch, unknownKey }`, where `fetch` answers the adapter's requests with recorded responses, a 401 for any other secret, and "not found" for `unknownKey`. `fixtures/fake.fixture.js` is the template.
3. Run `npx jest tests/issue-trackers`. The contract suite runs against every registered adapter and fails without a fixture.
4. Unit-test what the contract cannot see: how your adapter translates a query into the provider's filter language.
5. Update `CLAUDE.md` in the same commit.

`tests/issue-trackers/fake.tracker.js` is a complete adapter kept deliberately unlike Linear (`#12` keys, no priorities, open or closed). If the core ever assumes something only Linear has, the contract suite fails on the fake.

---

## Refused, for now

- **Adapters loaded at runtime** from the user's data directory. See the first decision above.
- **Webhooks.** No public URL on a desktop.
- **Reusing the claude.ai Linear connector.** Its token lives on claude.ai's side and is only usable through a model turn. The app needs its own credential.
- **Several providers merged in one list.** With more than one connection, the Tickets screen shows one at a time behind a switcher.

---

## Delivery

Three pull requests, each built on the previous one:

1. The Git tab in each session: branch, commits, pull request, checks and reviews (#237).
2. This layer and every surface on it: the core contract, connection settings with the key in the credential store, the Tickets screen (list, filters, detail, board, writes), the Tickets tab in each session (links, `@` mention, automatic detection and its confirmation card), starting a session from a ticket, the recap comment, and terminal sessions. All of it is tested against `tests/issue-trackers/fake.tracker.js`, which ships nothing.
3. The Linear adapter, its fixture, and the tests that need what only Linear has: priorities, teams with their own workflows, cycles, prefixed keys in branch names.
