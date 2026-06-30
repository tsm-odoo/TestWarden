# Warden -- Agent Reference

Warden is a headless CLI that runs Hoot tests in parallel browser workers and reports results as JSON lines on stderr.

## Launching

```
./warden [flags]
```

Must be run from the `backend/` directory so it can find `settings.json`.

### Flags

| Flag | Default | Description |
|---|---|---|
| `--server` | `http://localhost:8069` | Odoo server URL |
| `--suite` | `hoot` | Suite type; resolved to a URL path via `settings.json` `suites` map |
| `--suite-path` | _(from settings)_ | Override the suite URL path directly |
| `--suite-names` | _(all)_ | Comma-separated suite names to filter (e.g. `web,mail`) |
| `--test` | _(all)_ | Run a single test by full name or 8-char hex ID |
| `--workers` | `4` | Number of parallel browser contexts |
| `--fail-fast` | `false` | Stop on the first failure (`bail=1`) |

`--suite-names` and `--test` are mutually exclusive. Omit both to run all tests.

### settings.json

Warden reads `settings.json` from the working directory at startup. Flags override it.

```json
{
  "suites": {
    "hoot":     "/web/tests",
    "qunit":    "/web/tests/legacy",
    "livechat": "/im_livechat/static/tests/embed/livechat_test_suite.html"
  },
  "workers":  4,
  "minLoad":  15,
  "chrome":   "/path/to/chrome-headless-shell",
  "repositories": {
    "odoo": "/path/to/odoo",
    "enterprise": "/path/to/enterprise"
  }
}
```

`repositories` enables static file scanning for metadata (faster than fetching from the browser). Omit it to fall back to browser-based metadata fetch.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | All tests passed (or no tests matched) |
| `1` | One or more tests failed |
| `2` | Fatal startup error (browser, auth, metadata) |
| `130` | Interrupted (SIGINT/SIGTERM) |

---

## Output format

Every log line is a JSON object on **stderr**. Keys are always sorted alphabetically by `json.Marshal`. Every object has at minimum:

```json
{"event": "<name>", "level": "info|warn|error", ...fields}
```

Stdout is empty. Parse stderr line by line with `JSON.parse`.

---

## Event reference

### Startup sequence

These events appear once, in order, before any workers start.

| event | level | fields | description |
|---|---|---|---|
| `chrome_launch` | info | `status=start` | Chrome is launching |
| `chrome_launch` | info | `status=done ms=N` | Chrome ready |
| `chrome_launch` | error | `err=...` | Chrome failed to start → exit 2 |
| `db_fetch` | info | `status=start server=URL` | Fetching database list |
| `db_fetch` | info | `status=done ms=N` | Database found |
| `db_fetch` | error | `err=...` | Cannot reach server → exit 2 |
| `auth` | info | `status=start db=NAME` | Logging in as admin |
| `auth` | info | `status=done ms=N` | Authenticated |
| `auth` | error | `err=...` | Auth failed → exit 2 |
| `meta_fetch` | info | `status=start` | Fetching test metadata from browser (no repositories configured) |
| `meta_fetch` | info | `status=done ms=N` | Metadata ready |
| `meta_fetch` | error | `err=...` | Metadata fetch failed → exit 2 |
| `file_scan` | info | `status=start` | Scanning `*.test.js` files (repositories configured) |
| `file_scan` | info | `status=done ms=N` | Scan complete |
| `file_scan` | info | `files=N tests=N cached=N updated=N` | Scan statistics |
| `cache_miss` | warn | `err=...` | Cache unreadable; starting fresh (non-fatal) |
| `cache_write_fail` | warn | `err=...` | Cache could not be saved (non-fatal) |
| `tests_resolve` | info | `total=N workers=N` | N tests resolved, split across N workers |
| `tests_resolve` | error | `err=...` | Filter error (bad suite name / test ID) → exit 2 |
| `run_skip` | warn | _(none)_ | No tests matched the filters → exit 0 |

### Worker startup

These appear once per worker, nearly simultaneously.

| event | level | fields | description |
|---|---|---|---|
| `workers_launch` | info | `status=start n=N` | Spawning N workers |
| `workers_launch` | info | `status=done ms=N` | All workers launched |
| `worker_init` | info | `worker=N tests=N` | Worker N assigned N tests |
| `worker_start` | info | `worker=N tests=N url=URL` | Worker N navigated to its suite URL |
| `worker_run` | info | `worker=N` | Worker N clicked Run -- tests are executing |

### Per-test progress

These appear during execution, one per test per worker.

| event | level | fields | description |
|---|---|---|---|
| `test_started` | info | `worker=N test=FULL_NAME` | A test just started |
| `test_fail` | error | `worker=N test=FULL_NAME url=URL stack=TEXT` | A test failed; `stack` is the error + trace (may contain newlines) |

### Per-suite progress

These appear at the end of each suite

| event | level | fields | description |
|---|---|---|---|
| `suite_done` | info | `worker=N test=FULL_NAME ms=N passed=N failed=N` | A suite just finished, provide how many tests passed/failed and how much time it took|

### Worker and run completion

| event | level | fields | description |
|---|---|---|---|
| `worker_done` | info | `worker=N passed=N failed=N` | Worker N finished |
| `worker_error` | error | `worker=N err=TEXT` | Worker N crashed (browser/page error) |
| `run_done` | info | `passed=N failed=N total=N` | Final summary -- always the last line |

`run_done` is always emitted, even when `failed=0`. It is the sentinel that the run has ended.

---

## Normal run sequence

A clean 4-worker run looks like:

```
{"event":"chrome_launch","level":"info","status":"start"}
{"event":"chrome_launch","level":"info","ms":310,"status":"done"}
{"event":"db_fetch","level":"info","server":"http://localhost:8069","status":"start"}
{"event":"db_fetch","level":"info","ms":42,"status":"done"}
{"event":"auth","level":"info","db":"mydb","status":"start"}
{"event":"auth","level":"info","ms":91,"status":"done"}
{"event":"meta_fetch","level":"info","status":"start"}
{"event":"meta_fetch","level":"info","ms":4201,"status":"done"}
{"event":"tests_resolve","level":"info","total":1234,"workers":4}
{"event":"workers_launch","level":"info","n":4,"status":"start"}
{"event":"worker_init","level":"info","tests":309,"worker":0}
{"event":"worker_init","level":"info","tests":309,"worker":1}
{"event":"worker_init","level":"info","tests":308,"worker":2}
{"event":"worker_init","level":"info","tests":308,"worker":3}
{"event":"workers_launch","level":"info","ms":1,"n":4,"status":"done"}
{"event":"worker_start","level":"info","tests":309,"url":"http://...","worker":0}
{"event":"worker_run","level":"info","worker":0}
{"event":"test_started","level":"info","test":"@web/core/autocomplete/can be rendered","worker":0}
... (one test_started per test per worker, interleaved)
{"event":"worker_done","level":"info","failed":0,"passed":309,"worker":2}
{"event":"worker_done","level":"info","failed":0,"passed":309,"worker":0}
{"event":"worker_done","level":"info","failed":0,"passed":308,"worker":1}
{"event":"worker_done","level":"info","failed":0,"passed":308,"worker":3}
{"event":"run_done","level":"info","failed":0,"passed":1234,"total":1234}
```

---

## Detecting a hung or failed CLI

The CLI can hang silently at any step. Use these thresholds:

| Stuck condition | Threshold | Likely cause |
|---|---|---|
| `chrome_launch status=start` seen, no `done` | 30 s | Chrome binary missing or crashed |
| `db_fetch status=start` seen, no `done` | 15 s | Odoo server not reachable |
| `auth status=start` seen, no `done` | 15 s | Server reachable but slow or auth RPC failing |
| `meta_fetch status=start` seen, no `done` | 120 s | Page load failed or Hoot never initialised (JS error, wrong URL) |
| `file_scan status=start` seen, no `done` | 60 s | Disk I/O stall or very large codebase |
| `workers_launch status=done` seen, but a worker never emits `worker_start` | 30 s | Browser context creation failed |
| `worker_run` seen for worker N, but no `test_started` within | 60 s | Hoot never started (click failed, page crashed) |
| `test_started` events stop for all workers | 120 s | A test is hanging (infinite loop, unresolved promise) |
| `worker_done` never seen for a worker after last `test_started` | 120 s | Worker lost connection to Chrome |
| Process exits with code 2 before `run_done` | immediate | Fatal startup error; check the `error` level event for `err` field |

**General rule:** if no new JSON line appears on stderr for **120 seconds**, assume the process is hung. Send SIGTERM; warden exits 130.

---

## Interpreting results

```python
# Pseudocode for parsing warden output
for line in stderr:
    ev = JSON.parse(line)

    if ev.event == "run_done":
        # Terminal event -- always present
        print(f"{ev.passed}/{ev.total} passed, {ev.failed} failed")
        success = ev.failed == 0

    if ev.event == "test_fail":
        # ev.test   -- full test name
        # ev.url    -- open in browser to reproduce with debugTest=true
        # ev.stack  -- error message + stack trace (may be empty)
        record_failure(ev.test, ev.url, ev.stack)

    if ev.level == "error" and ev.event != "test_fail":
        # Fatal infrastructure error
        abort(ev.event, ev.err)
```

Key fields for result processing:

| Field | Event | Meaning |
|---|---|---|
| `run_done.passed` | `run_done` | Tests that passed |
| `run_done.failed` | `run_done` | Tests that failed |
| `run_done.total` | `run_done` | Total tests executed |
| `test_fail.test` | `test_fail` | Full test name (`@addon/path/suite/test`) |
| `test_fail.url` | `test_fail` | URL to reproduce the failure with `debugTest=true` |
| `test_fail.stack` | `test_fail` | Error message and stack trace; empty string if unavailable |
