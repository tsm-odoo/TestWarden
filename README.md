# test-warden

Runs Odoo's Hoot tests in parallel headless Chrome tabs and shows live progress in the
terminal.

- **`engine/`**: a Go binary (`engine/dist/engine-<os>-<arch>`) that launches Chrome, talks to the Odoo server,
  and drives the actual test runs.
- **`client/`**: a small Node/TypeScript CLI that spawns the engine binary for the current platform, parses its JSON
  output, and renders the progress bar / logs.

## Setup

```bash
npm install
npm run build      # compiles and bundles client into `release/`

cd engine
make release
```

## Running

```bash
node release/test-warden.cjs --server-url http://localhost:8069 --suite hoot
```

Run `node release/test-warden.cjs --help` at any time for the full, current list of flags,
this doc only covers the most useful ones.

| Flag | What it does |
|---|---|
| `--suite <path-or-name>` | Which suite to run: a name (`hoot` and `livechat` are built in, more via `settings.json`). Use `--suite-path` for a literal URL path. An unknown name fails instead of running everything |
| `-t, --test <id>` | Run a single test, by name (partial name accepted) or ID|
| `--workers <n>` | Parallel browser contexts (default 4). Tests tagged `focus required` still run alone, on one worker after the others |
| `--fail-fast` | Stop at the first failure instead of finishing the run |
| `--once` | Run once and exit instead of looping until a failure |
| `--flaky-check <n>` | Repeat a single test (`-t`) N times total (split across `--workers`) without stopping on failure, then report how often it passed vs failed |
| `--visible` | Show the browser window with devtools open |
| `--cpu-throttling` | Throttle the cpu, making it easier to reproduce runbot scenario (high load) (2/4 is a good starting point) |
| `--debug` | Show the UI for interactive debugging (implies `-t`, one worker, visible) |
| `--console` | Print the browser's `console.log/info/debug/warn` lines, prefixed with the test that logged them; objects are shown as `{a: 1, b: "x"}` |
| `--worker-timeout <s>` | Fail a worker that shows no test progress for this many seconds (default 60, `0` disables). Its already finished tests stay counted, and the ones it never reached are listed as not run |

## `settings.json`

Read from `engine/settings.json` at startup; every field is optional.

```json
{
  "serverURL": "http://localhost:8069",
  "workers": 4,
  "suites": {
    "hoot": "/web/tests",
    "livechat": "/web/tests/livechat"
  },
  "chrome": "/path/to/chrome-headless-shell"
}
```

Test metadata are read from the live suite page on every run, so new tests are picked up
as soon as the server serves them.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All tests passed |
| `1` | One or more tests failed, or a worker crashed or stalled |
| `2` | Fatal startup error (Chrome, auth, server unreachable, ...) |
| `3` | No tests matched the filters |
| `130` | Interrupted (Ctrl+C) |

## Building automation on top of warden

If you're scripting against the engine directly, see `engine/README.md` that documents the
JSON event protocol warden emits on stdout.

## Skill for coding agents

`skills/test-warden/SKILL.md` tells an agent how to run the engine against a local Odoo
server and what a result is worth. Copy or link the `skills/test-warden` folder into the
skills folder of the agent (`.claude/skills/` for Claude Code, `.agents/skills/` for others).
