# Workflow Lab

Executes every workflow node **for real** in an isolated sandbox.

This is a dev tool. `scripts/` is not in `electron-builder.config.js`'s `files`
allowlist, so nothing here ships in the app.

## Why

Before this existed, 19 of 27 node types had never been executed by anything —
not by a test, not by CI. The only checks were structural (does the definition
look right?), which says nothing about behaviour. The lab found a real bug on
its first run: `**/*.js` in the `file` node matched no top-level file, silently,
including for the pattern the MCP tool docs recommend.

## Usage

```bash
npm run lab                  # every scenario, plus the coverage gate
npm run lab -- --only=shell  # one node type
npm run lab -- --verbose     # print failure stacks
```

Exit code is non-zero when a scenario fails **or when a registered node type has
no scenario file**. That second rule is the point: a new node cannot quietly
arrive untested.

## Adding a node

Create `scenarios/<type>.scenario.js`. It is picked up automatically.

```js
'use strict';
const { assert } = require('../sandbox');

module.exports = {
  type: 'my_node',
  scenarios: [
    {
      name: 'what this proves',
      async setup(sb) { sb.file('fixture.txt', 'data'); },   // optional
      config: (sb) => ({ path: sb.dir }),                    // node properties
      assert(out, sb) { assert.strictEqual(out.success, true); },
    },
  ],
};
```

Scenario keys:

| key | meaning |
|---|---|
| `name` | what the scenario proves — write the claim, not the mechanics |
| `setup(sb)` | optional fixtures, runs before the node |
| `config` | node properties; object or `(sb) => object` |
| `graph(sb)` | drive the full `WorkflowRunner` instead of `run()` — needed for control-flow nodes whose behaviour lives in the runner (`condition`, `loop`, `switch`, `retry`, `error_handler`) |
| `expectThrow` | the run **must** reject; `assert` then receives the error |
| `assert(out, sb)` | throw to fail |

A module may declare `skip: 'reason'` instead of scenarios. Skips are printed on
every run, never silent — use it only for nodes with irreversible external side
effects, and say why.

## Sandbox

Each scenario gets a fresh `sb`:

| member | purpose |
|---|---|
| `sb.dir` | throwaway working directory |
| `sb.home` | fake `$HOME`, so `~/.claude-terminal` and `~/.claude` are disposable |
| `sb.file(rel, content)` / `sb.read(rel)` / `sb.exists(rel)` | fixtures |
| `sb.dataFile(name, obj)` | write into the fake `~/.claude-terminal` |
| `sb.gitRepo()` | init a repo with one commit |
| `sb.sqlite(name)` | sqlite file seeded with an `items` table |
| `sb.http(handler)` | local HTTP server — see the caveat below |
| `sb.vars` | the variables Map passed to `run()` |
| `sb.ctx` | node ctx: recording `sendFn`, stub `chatService` |
| `sb.sent` / `sb.sentOn(ch)` | everything the node emitted |
| `sb.prompts` | every prompt the stub chatService received |

The fake home works by overriding `USERPROFILE`/`HOME`, which `os.homedir()`
reads on each call. It is restored on `cleanup()`.

### Caveat: nodes with an SSRF guard

`http` and `webhook` run URLs through `assertSafeUrl`, which rejects loopback,
RFC-1918 and link-local addresses. `sb.http()` is therefore unusable for them —
and, worth knowing, **those nodes cannot reach a local dev server or anything on
the LAN either**. Their scenarios pin the guard instead of trying to defeat it.

`notify_discord` needs no such guard: it hardcodes an allowlist for
`discord.com/api/webhooks/`.
