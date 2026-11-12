# engine

`engine-<os>-<arch>` (in `dist/`) is the Go binary that launches Chrome, drives Hoot tests in parallel
browser workers, and reports results as JSON lines on stdout. Run it from this directory
(it reads `settings.json` from the cwd).

## Flags

| Flag | Default | Description |
|---|---|---|
| `--server` | `http://localhost:8069` | Odoo server URL |
| `--suite` | `hoot` | Name resolved to a URL path: built-in `hoot` (`/web/tests`) and `livechat` (`/web/tests/livechat`), plus `settings.json`'s `suites` map, which wins on conflict. An unknown name is a fatal error (exit `2`) |
| `--suite-path` | _(empty)_ | Skip the map and give the URL path directly (e.g. `/web/tests`); wins over `--suite` when set. With `preset=mobile` in its query, Chrome runs at 375x667 with touch events, and the `mobile` tests run instead of the `desktop` ones, like Odoo's `MobileWebSuite` |
| `--suite-names` | _(all)_ | Comma-separated suite names to filter (e.g. `web,mail`) |
| `--test` | _(all)_ | Run a single test by full name or 8-char hex ID |
| `--workers` | `4` (or `workers` in `settings.json`) | Number of parallel browser contexts. With `--test`, every worker runs the same test independently while with `--suite-names` every test of the suite is split across workers. The `minLoad` based worker capping only applies to suites. Tests tagged `focus required` never run alongside another page: in a split run they go to a single worker once the others are done, and a single `--test` drops to one worker |
| `--fail-fast` | `false` | Stop on the first failure (`bail=1`) |
| `--run-until-fail` | `false` | Run tests (reloading pages) until a failure is found |
| `--flaky-check` | `0` | Repeat a single test N times total (split across `--workers`, rounded up) without stopping on failure, then report a pass/fail ratio (requires `--test`; incompatible with `--run-until-fail`, `--fail-fast`, `--debug`) |
| `--visible` | `false` | Launch a visible browser with devtools and a full-screen window |
| `--pause-before-exit` | `false` | Keep the browser open after a failure; press any key to quit |
| `--debug` | `false` | Pause for debugging on a single test. implies `--pause-before-exit` and `--workers 1`|
| `--console` | `false` | Emit `console` events for the browser console lines Hoot doesn't emit itself (top-level `console.log/info/debug/warn` calls), attributed to the running test. Objects and arrays are rendered from their preview (`{a: 1, b: "x"}`, cut with `…` when large) |
| `--worker-timeout` | `60` | Seconds a worker may go without test progress (a test starting or a suite ending) before its page is closed and the worker fails the run. `0` disables; never armed with `--debug` |

## settings.json

```json
{
  "suites": {
    "hoot":     "/web/tests",
    "livechat": "/web/tests/livechat"
  },
  "minLoad":  15,
  "chrome":   "/path/to/chrome-headless-shell",
  "memoryLimit": "2G",
  "workers": 4
}
```

Test metadata are read from the suite page on every run. That page load also warms the
response cache the workers share, so they don't all fetch the test bundle themselves.

Chrome binaries (auto-downloaded if `chrome` is unset) are cached at
`~/.cache/warden/chrome-headless-shell/`.

Set `memoryLimit` (Linux only, e.g. `"2G"`, `"512M"`) to cap the combined RAM usage of the
engine and every Chrome instance it spawns. The engine is piped to `systemd-run --user
--scope` with that value as `MemoryHigh`: a soft limit, so Linux reclaims caches and
throttles the group under pressure instead of OOM-killing it.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All tests passed |
| `1` | One or more tests failed, or a worker crashed or stalled (`--worker-timeout`). The tests a dead worker had already finished still count in `run_done`; the ones it never reached are listed in `tests_not_run` and are not counted |
| `2` | Fatal startup error: unknown `--suite`, Chrome launch, DB lookup, auth, metadata fetch, bad suite/test filter, `--debug` not resolving to one test, or worker setup failure |
| `3` | No tests matched the filters |
| `130` | Interrupted (SIGINT/SIGTERM) |

---

## Output protocol

Every line on stdout is one JSON object, tagged by `type`. Parse line by line.

| `type` | Fields | Meaning |
|---|---|---|
| `step_start` / `step_done` | `key, label[, ms]` | A startup step (`chrome_launch`, `db_fetch`, `auth`, `meta_fetch`, `workers_launch`) starts/finishes |
| `diagnostic` | `level (warn\|error), label, message` | Warning or fatal error. `chrome_connect`: Chrome started but the engine could not connect to its DevTools endpoint (exit 2) |
| `run_start` | `run, total` | A run begins (`run` increments across `--run-until-fail` iterations) |
| `test_started` | `test` | Test started (full name) |
| `test_fail` | `worker, id, test, url, stack` | Test failed; `url` reproduces it with `debugTest=true` |
| `suite_done` | `worker, suite, passed, failed, ms` | A suite finished |
| `worker_start` | `worker, devtools` | Worker's page is ready; `devtools` is an inspector URL |
| `worker_run` | `worker` | Worker clicked Run |
| `worker_done` | `worker, passed, failed` | Worker finished the run |
| `worker_error` | via `diagnostic`, `label, message` | Worker/browser crashed or stalled mid-run |
| `tests_not_run` | `worker, count, ids` | A worker died (stalled, page error) before reaching these tests of its share; sent right before its `worker_error`. They are not in `run_done`'s `passed`/`failed`/`total`. Not sent with `--flaky-check`/`--run-until-fail` |
| `console` | `worker, test, level, text` | Browser console line (`--console` only); `test` is empty outside of a test |
| `run_done` | `run, passed, failed, total, willRerun` | End of run: always the last line of a run |
| `run_wait_prompt` | _(none)_ | About to block on stdin (`--pause-before-exit` after a failure) |
| `log` | `kind, text` | Free-form info line, e.g. `"ℹ N tests across M workers"` |

Example:

```
{"type":"step_start","key":"chrome_launch","label":"Launching Chrome"}
{"type":"step_done","key":"chrome_launch","label":"Launching Chrome","ms":310}
{"type":"step_start","key":"db_fetch","label":"Fetching database"}
{"type":"step_done","key":"db_fetch","label":"Fetching database","ms":42}
{"type":"step_start","key":"auth","label":"Authenticating to mydb"}
{"type":"step_done","key":"auth","label":"Authenticating to mydb","ms":91}
{"type":"step_start","key":"meta_fetch","label":"Loading test metadata"}
{"type":"step_done","key":"meta_fetch","label":"Loading test metadata","ms":3500}
{"type":"log","kind":"info","text":"ℹ 1234 tests across 4 workers"}
{"type":"step_start","key":"workers_launch","label":"Launching workers"}
{"type":"step_done","key":"workers_launch","label":"Launching workers","ms":1}
{"type":"run_start","run":1,"total":1234}
{"type":"worker_start","worker":0,"devtools":"http://127.0.0.1:9222/devtools/inspector.html?..."}
{"type":"worker_run","worker":0}
{"type":"test_started","test":"@web/core/autocomplete/can be rendered"}
... (test_started/suite_done per test/suite, interleaved across workers)
{"type":"worker_done","worker":0,"passed":309,"failed":0}
{"type":"run_done","run":1,"passed":1234,"failed":0,"total":1234,"willRerun":false}
```
