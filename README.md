# TestWarden

Test Warden is a CLI launcher for unit testing that runs tests until failure, reporting screenshots, logs, and notifying when failures occur.

## CLI Options

`node release/test-warden.cjs --help` to get full option list.


## Configuration

You can configure the test warden launcher via a `settings.json` file placed in the root of your project.

- `suites`: Allow to define several suites, linked to a relative URL.

e.g.

```json
{
    "suites": {
        "hoot": "/web/tests",
        "qunit": "/web/tests/legacy"
    },
}
```

```
test-warden -m @mail --suite hoot
```
