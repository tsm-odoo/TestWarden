# TestWarden

Test Warden is a CLI launcher for unit testing that runs tests until failure, reporting screenshots, logs, and notifying when failures occur.

## CLI Options

- `--debug`: Enable debug mode for a single test.

- `--visible`: Specifie whether to use headless chrome or not.

- `--workers <number>`: Set the number of chrome instances used to speed up the testing process.

- `--server-url <url>`: Specifie the base URL of the server running the unit tests. Default is "http://localhost:8069".

- `--suite <path>`: Set the relative path of the suite that will be concatenated to the server URL to reach the suite. Default is "/web/tests/next".

- `--fail-fast`: Determine whether to stop on the first test failure.

- `--tests-per-worker <number>`: Set the minimum number of tests to run per worker. If 20 tests need to be run with 4 workers and 10 tests per worker, 2 workers will be used.

### Additional Options (Not Yet Implemented)

- `--only-last-stats`: Not yet implemented.

- `--mobile`: Not yet implemented.

- `--prompt-for-retry`: Not yet implemented.

- `--open-fail-folder`: Not yet implemented.
