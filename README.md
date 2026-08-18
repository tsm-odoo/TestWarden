# test-warden

Runs Odoo's Hoot tests in parallel headless Chrome tabs and shows live progress in the
terminal.

- **`engine/`** — a Go binary (`test-warden-engine`) that launches Chrome, talks to the Odoo server,
  and drives the actual test runs.
- **`client/`** — a small Node/TypeScript CLI that spawns `test-warden-engine`, parses its JSON
  output, and renders the progress bar / logs.

## Setup (should already be done)

```bash
npm install
npm run build      # compiles and bundles client into release/test-warden.mjs

cd engine
make release
```

## Running

```bash
node release/test-warden.cjs --server-url http://localhost:8069 --suite hoot
```

Run `node release/test-warden.cjs --help` at any time for the full, current list of flags,
this doc only covers the most usefull ones.

| Flag | What it does |
|---|---|
| `--suite <path-or-name>` | Which suite to run: a name resolved via `settings.json`, or a literal path (e.g. `/web/tests`) |
| `-t, --test <id>` | Run a single test, by name (partial name accepted) or ID|
| `--workers <n>` | Parallel browser contexts (default 4) |
| `--fail-fast` | Stop at the first failure instead of finishing the run |
| `--once` | Run once and exit instead of looping until a failure |
| `--flaky-check <n>` | Repeat a single test (`-t`) N times total (split across `--workers`) without stopping on failure, then report how often it passed vs failed |
| `--visible` | Show the browser window with devtools open |
| `--cpu-throttling` | Throttle the cpu, making it easier to reproduce runbot scenario (high load) (2/4 is a good starting point) |
| `--debug` | Show the UI for interactive debugging (implies `-t`, one worker, visible) |

## `settings.json`

Read from `engine/settings.json` at startup; every field is optional.

```json
{
  "serverURL": "http://localhost:8069",
  "workers": 4,
  "suites": {
    "hoot": "/web/tests",
    "livechat": "/im_livechat/static/tests/embed/livechat_test_suite.html"
  },
  "chrome": "/path/to/chrome-headless-shell",
  "worktreeContainer": "/path/to/worktree/container"
}
```

**Set `worktreeContainer`.** Without it, test metadata are re fetched from the browser on
every single run. With it, warden fingerprints addons' `*.test.js` files and reuses cached
metadata whenever they haven't changed for a much faster startup.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All tests passed |
| `1` | One or more tests failed |
| `2` | Fatal startup error (Chrome, auth, server unreachable, ...) |
| `3` | No tests matched the filters |
| `130` | Interrupted (Ctrl+C) |

## Building automation on top of warden

If you're scripting against the engine directly, see `engine/README.md` that documents the
JSON event protocol warden emits on stdout.
