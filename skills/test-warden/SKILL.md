---
name: test-warden
description: >-
  Run Odoo's Hoot (JS) tests with the TestWarden engine: parallel headless Chrome pages, one
  JSON event per line on stdout, real exit codes. Use it to run a Hoot test, file or module
  against a local Odoo server, to hunt a flaky test (--flaky-check, --cpu-throttling), to check a
  fix by running its test before and after, to read a failed or hung run, or to prove that the
  server serves your latest edit. It also covers the database and the server the engine needs.
  Tours, the QUnit suite of 17.0 and older, and Hoot's own internal suite run through odoo-bin,
  not through the engine.
---

# TestWarden

TestWarden runs the Hoot tests of an Odoo server in parallel headless Chrome pages, much faster
than the odoo-bin runner. It has two parts:

- the engine, `engine/dist/engine-<os>-<arch>` of this repo: it launches Chrome, drives the test
  pages, prints one JSON object per line on stdout and exits with a code that says what happened.
  A script or an agent runs the engine and reads its JSON;
- the client, `release/test-warden.cjs`: it starts the engine and draws a terminal UI for a
  person. Same flags, same exit code.

Every flag, event and exit code is listed in `engine/README.md` of this repo, and
`<engine> --help` prints the flags of the binary at hand. This skill says how to use them, and
what a result is worth.

## 1. A database built from the code under test

The compiled asset bundles are stored IN the database (`ir_attachment` rows plus the filestore).
A database built from another branch keeps serving the code of that branch. So build the
database from the checkout you test, and install the modules once:

```bash
createdb -T template0 -E UTF8 --lc-collate=C "$DB"
cd "$ODOO" && python3 odoo-bin -d "$DB" --addons-path="$ADDONS" \
  -i mail --stop-after-init --max-cron-threads=0 --log-level=warn
```

- Hoot only runs the tests of INSTALLED modules: install everything the suites need at creation.
  For an enterprise module, add the enterprise checkout to the addons path, and install
  `web_enterprise` when the test depends on the edition (the design tokens differ).
- Never `-u`, and never `-i` on an existing database to run a test: it rebuilds every bundle and
  changes the database. Install at creation, then only run.
- Keep the name under 63 characters. Postgres cuts a longer name, Odoo names the filestore after
  the uncut one, and every attachment read then fails.
- A database copied with `createdb -T` from a database of another branch serves the bundles of
  that branch until they are rebuilt (section 4).

## 2. A server of your own

```bash
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
cd "$ODOO" && nohup python3 odoo-bin -d "$DB" --http-port=$PORT --max-cron-threads=0 \
  --addons-path="$ADDONS" > server.log 2>&1 &
echo $! > server.pid
for i in $(seq 1 90); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/web/login" && break; sleep 2; done
```

- Start it with `-d "$DB"`, or a `--db-filter` that only matches it: the engine logs in as
  `admin`/`admin` on the FIRST database that `/web/database/list` returns.
- The same addons path as the install.
- Restart the server after a rebase, after adding, moving or deleting a `*.test.js` file, and
  after any python change. A running server never adds a new file to its bundles and keeps its
  old python. After a rebase, a stale server shows as an auth error of the engine
  (`authenticate: column ... does not exist`, exit 2), not as a test failure.
- No `--dev` is needed: the engine loads the suite with `?debug=assets`, so every page load reads
  the JS files from disk.
- Stop it by its PID: `kill $(cat server.pid)`. `pkill -f <pattern>` also matches the shell that
  runs it. With `--dev`, the PID is the reloader, and its child keeps the port: check
  `ss -ltnp | grep ":$PORT"` after the kill.

## 3. Run the engine

```bash
E=<this repo>/engine/dist/engine-linux-amd64
$E --server http://127.0.0.1:$PORT --suite-names '@mail/core/thread' --workers 2 > run.jsonl; echo "EXIT=$?"
grep '"type":"run_done"' run.jsonl       # passed / failed / total
grep '"type":"diagnostic"' run.jsonl     # why a run never started, a stalled worker
python3 -c 'import json,sys; [print(e["test"], e["stack"], sep="\n") for e in map(json.loads, open(sys.argv[1])) if e.get("type")=="test_fail"]' run.jsonl
```

- `settings.json` in the working directory is optional. Without its `chrome` entry, the first
  run downloads `chrome-headless-shell` into `~/.cache/warden/` (network needed once).
- A long run (a whole module, a flake hunt) goes to the background, its output in a file and
  `echo "EXIT=$?"` at the end. Read that line: a pipe after the engine reports its own code.

Which tests:

| Flag | Selects |
| --- | --- |
| `--suite-names '@a,@b'` | suites by their EXACT full name. Odoo wraps each `*.test.js` in `describe(getSuitePath(module))` and Hoot splits that name on `/`, so `@mail` is the whole module, `@web/core/utils/objects` one file, a deeper name a `describe` of it. A bare leaf name is unknown |
| `--test '<name or id>'` | one test: a case-insensitive substring of its full name that matches only that test, or its 8-character hex id |
| `--suite livechat`, `--suite-path <path>` | another suite page: `livechat` is `/web/tests/livechat` (needs `im_livechat` installed); a mobile run is `--suite-path "/web/tests?debug=assets&preset=mobile&x="` (section 6) |

- An unknown suite name stops the WHOLE run (exit 2): a module that does not exist on this
  branch kills a run of several suites.
- The id of a failure expires once the test passes again or the code moves (`test not found`,
  exit 2). A name substring survives a rebase.
- Tests tagged `skip` never run. Tests tagged `mobile` only run with the mobile preset, which
  skips the `desktop` ones and runs at 375x667 with touch events, like Odoo's `MobileWebSuite`.

Workers:

- No more workers than free cores: more only adds timeouts the CI does not have. `--workers 2`
  for a module, one for a single test.
- A single `--test` runs on one worker, unless `--flaky-check` or `--run-until-fail` is given.
- Tests tagged `focus required` (on the test or on a `describe`) never run beside another page:
  in a split run they go to one worker once the others are done, and a `--test` on one drops to
  a single worker (a `tests_resolve` warning). Parallel pages take the focus from each other, and
  the engine only sees the tag: a test that asserts `:focus` without it can fail at
  `--workers 2` and pass at `--workers 1`. Run such a test alone before believing its failure.

## 4. What a result is worth

| Exit | Meaning |
| --- | --- |
| `0` | all passed |
| `1` | a test failed (a `console.warn` during a test counts), or a worker crashed or stalled |
| `2` | the run never started: Chrome, the server, auth, an unknown suite, a test not found or ambiguous, a JS error while the bundle loads |
| `3` | no test matched the filters |
| `130` | interrupted |

A green run is only worth something if it ran YOUR code and the tests you meant:

- Compare `run_done.total` with what the suite should hold. Count from `run_done`: the
  `test_started` lines undercount. For a run you killed midway, sum `passed` of the `suite_done`
  events whose `suite` is a file path: nested `describe` blocks report their own, so a sum over
  all of them counts twice.
- A worker that died (stalled, page error) sends `tests_not_run` with the ids it never reached,
  before its `worker_error` diagnostic: the tests it finished still count in `run_done`. Run the
  missing ones again rather than the whole suite.
- A `console.warn` while a test runs fails that test: its `test_fail` stack reads
  `Warning during test: <text>`. A warning outside a test (suite setup, module load, after the
  last test) is not caught; Odoo's own runner, `odoo-bin --test-tags
  '/<module>:WebSuite.test_unit_desktop'`, fails on those too, as Odoo's CI does.
- The `url` of a `test_fail` (`debugTest=true`) is for a person in a browser. A script runs the
  test again with `--test`.
- `timeout waiting for Hoot to register tests` (exit 2) right after an edit is the first page load
  rebuilding the bundle on a busy machine: run once more. If it stays, a test file was deleted or
  moved under a running server: restart it.

**Prove that the server serves your edit** when a result surprises you. Fetch the bundle as admin
and grep a string literal unique to the edit (literals survive minification):

```bash
curl -s -c cookies.txt -H 'Content-Type: application/json' http://127.0.0.1:$PORT/web/session/authenticate \
  -d "{\"params\": {\"db\": \"$DB\", \"login\": \"admin\", \"password\": \"admin\"}}" > /dev/null
curl -s -b cookies.txt -o bundle.js http://127.0.0.1:$PORT/web/assets/debug/web.assets_unit_tests.js
grep -c '<marker>' bundle.js
```

A fetch without the session cookie can get the login page and grep 0. If the marker is missing,
restart the server; if that is not enough, delete the bundle attachments and run again:
`psql -d "$DB" -c "DELETE FROM ir_attachment WHERE url LIKE '/web/assets/%';"`. This is a
recovery, not a step before each run. When a new file still does not show:

1. Compare the start time of the server with the time of the file: `ps -o pid,lstart,args -p
   $(cat server.pid)` and `stat -c %y <file>`. A restart may have died on `Address already in
   use` while the old server kept the port: read the first lines of the new server log.
2. Grep the bundle for the module of the file: `grep -c '@<module>/<path>' bundle.js`.
3. In the page: `odoo.loader.modules.has("@<module>/<path>")`, printed through a failing
   assertion.
4. One test through odoo-bin builds its bundles fresh
   (`--test-tags '/web:WebSuite.test_unit_desktop[@<module>/<path>/<test title>]'`): green
   there and red in the engine points at the server, not at the code.

When the CI contradicts a local green, delete the bundle attachments and run the suite again
before trusting any local run.

**A broken database**: a suite that worked is now `unknown suite`, `relation ... does not exist`,
a module gone from `ir_module_module`. A code change cannot make a suite name disappear. Build a
fresh database (section 1); never `-u all` to catch up.

## 5. Flaky tests

`--flaky-check N --test '<name>'` runs one test N times in all, without stopping on a failure,
then prints each distinct failure with its stack and a `flaky_result` event (`passed`, `failed`,
`total`). It cannot be combined with `--run-until-fail`, `--fail-fast` or `--debug`.

- N is split over the workers (rounded up), and each worker repeats the test IN THE SAME PAGE.
  That is what makes it fast, but the state one repetition leaves on the page is seen by the
  next: a test that fails only from the second repetition on is leaking state (or a probe that
  keeps a global: reset it at the top of the test).
- For a fresh page per run: `--flaky-check N --workers N` (N pages, keep N small; a
  `focus required` test stays on one worker), or a shell loop of single runs, the slow and fully
  isolated option.
- The in-page repetition can hide a render race: unfixed code read 20/20 green with
  `--flaky-check 20`, while single runs of the same code were red. To compare before and after
  a fix of such a race, loop single runs, and have the test report whether the loaded source
  holds the fix (`fn.toString().includes("<marker>")`), so one run also tells a stale bundle.
- `--cpu-throttling F` slows the CPU of each page by F (2 to 4 to start) and brings out races
  that only show on a loaded CI. A high factor creates other failures (render and load timeouts)
  that fail the code before and after the fix alike: then drop the throttle and raise N. It
  models a sustained slowdown, not a frozen machine.
- `--run-until-fail` reloads and runs again until a failure.
- Write the load of the machine (`cat /proc/loadavg`) next to every failure rate you quote: the
  same test can fail 4/20 under a heavy load and pass 20/20 once it drops.

## 6. Traps and open limits

- **Never edit the sources while a run is in flight.** Each page load fetches the files again,
  so the tests loaded after the edit run other code than the ones loaded before. To stop a run,
  kill the engine and its `chrome-headless-shell` processes by PID:
  `ps -eo pid,args | awk '/[c]hrome-headless-shell|[e]ngine-/ {print $1}'`.
- **A `--suite-path` with a query string.** The engine appends `?debug=assets&timeout=15000&...`
  to the path as given, so a path with its own `?` makes that the end of its last value:
  `/web/tests?preset=mobile` loads `preset=mobile?debug=assets`, with neither the debug assets
  nor the mobile preset. End the path with a throwaway parameter:
  `"/web/tests?debug=assets&preset=mobile&x="`.
- **`--suite` knows `hoot` and `livechat`**, plus the `suites` map of `settings.json`. Any other
  name exits 2 with `unknown suite "<name>" (known: ...)`; every other page is a `--suite-path`.
- **A test wrapped as `test.timeout(ms)("<title>", ...)`** hides its title from the metadata pass:
  `--test` answers `test not found`.
- **The per-test timeout is 15 s**, as in Odoo's `test_js.py` (`timeout=15000` in the URL); no
  flag changes it.
- **The engine is not a timing tool.** It loads the suite with `debug=assets` and the Hoot UI,
  so the time of a test overstates what the CI pays. Measure a suite with odoo-bin and the
  timestamps of the server log.
- **`--console`** forwards `console.log`, `info`, `debug` and `warn` lines that Hoot did not
  print itself (nothing inside a console group, nothing with Hoot's styled header), with the test
  that was running; `test` is empty outside a test. Objects are shown from their preview
  (`{a: 1, b: "x"}`). Errors are not forwarded (they end the run as page errors), nor the
  content of `expect.step` steps: dump those through a failing assertion,
  `expect(JSON.stringify(value)).toBe("DUMP")`.
- **A stalled worker.** After `--worker-timeout` seconds (60) with no test starting and no suite
  ending, the engine closes the page and sends a `worker_error` diagnostic,
  `worker stalled: no test progress for <N>s (last test started: "<name>"), page closed`: exit
  1, with no `test_fail`. A frozen page is not the fault of that test until it freezes alone.
  `--flaky-check` does not trip it, as each repetition counts as progress.
- **Hoot's own internal suite** (`/web/static/lib/hoot/tests/index.html`) cannot be driven by
  the engine: run it with `odoo-bin --test-tags /web:WebSuite.test_hoot`.
- **Media and peers.** `chrome-headless-shell` has no fake camera or screen, and WebRTC between
  two peers may never connect inside a container: such tests can be red locally and green on
  the CI. Run them on the base commit before blaming a change.
