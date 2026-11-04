// Engine output protocol: one JSON object per line on stdout, consumed by the client UI.

package log

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// Readable labels for timed steps, shared between the start/done pair and diagnostics
// that reference the same step.
var stepLabels = map[string]string{
	"chrome_launch":         "Launching Chrome",
	"db_fetch":              "Fetching database",
	"download_chrome_shell": "Downloading chrome headless shell",
	"auth":                  "Authenticating",
	"meta_fetch":            "Loading test metadata",
	"workers_launch":        "Launching workers",
}

func label(event string) string {
	if l, ok := stepLabels[event]; ok {
		return l
	}
	return event
}

// Writes a single JSON line to stdout.
func emit(fields map[string]any) {
	jsonBytes, _ := json.Marshal(fields)
	fmt.Fprintf(os.Stdout, "%s\n", jsonBytes)
}

// Converts alternating key/value args into a map. error values are converted to their
// string message so json.Marshal doesn't emit {}.
func kv(args []any) map[string]any {
	fieldMap := make(map[string]any, len(args)/2+2)
	for i := 0; i+1 < len(args); i += 2 {
		if key, ok := args[i].(string); ok {
			val := args[i+1]
			if err, ok := val.(error); ok {
				val = err.Error()
			}
			fieldMap[key] = val
		}
	}
	return fieldMap
}

// Starts a timed step under key, using its built-in label. Returns a done func that emits
// step_done with the elapsed time when called.
func Step(key string) func() {
	return StepLabel(key, label(key))
}

// Like Step, but with an explicit label instead of the built-in one (e.g. when the label
// needs runtime data such as a database name).
func StepLabel(key, lbl string) func() {
	emit(map[string]any{"type": "step_start", "key": key, "label": lbl})
	start := time.Now()
	return func() {
		emit(map[string]any{
			"type":  "step_done",
			"key":   key,
			"label": lbl,
			"ms":    time.Since(start).Milliseconds(),
		})
	}
}

func RunStart(run, total int, multi bool) {
	emit(map[string]any{"type": "run_start", "run": run, "total": total, "multi": multi})
}

func TestStarted(test string) {
	emit(map[string]any{"type": "test_started", "test": test})
}

func RunDone(run, passed, failed, total int, willRerun bool) {
	emit(map[string]any{
		"type":      "run_done",
		"run":       run,
		"passed":    passed,
		"failed":    failed,
		"total":     total,
		"willRerun": willRerun,
	})
}

func RunWaitPrompt() {
	emit(map[string]any{"type": "run_wait_prompt"})
}

// Reports the aggregate pass/fail ratio across every --flaky-check repetition of a single
// test. Kept out of LogLine/the scrolling log so the client can pin it right above the
// quit prompt instead of burying it among earlier setup messages.
func FlakyResult(passed, failed, total int) {
	emit(map[string]any{"type": "flaky_result", "passed": passed, "failed": failed, "total": total})
}

func LogLine(kind, text string) {
	emit(map[string]any{"type": "log", "kind": kind, "text": text})
}

// Delimits a dynamic value embedded in a LogLine/StepLabel message, so the client can
// render just that span in a highlight color. A control character is used instead of
// visible punctuation so it can't collide with real message content (e.g. literal quotes
// from %q).
const dynMarker = "\x1e"

// Wraps a value that varies per run (a name, path, or count) so the client can render
// it highlighted instead of blending into the surrounding static text.
func Dyn(value string) string {
	return dynMarker + value + dynMarker
}

func TestFail(worker int, id, test, url, stack string) {
	emit(map[string]any{"type": "test_fail", "worker": worker, "id": id, "test": test, "url": url, "stack": stack})
}

// Lists the tests of a worker that died before reaching them, so they aren't mistaken for
// passed ones.
func TestsNotRun(worker int, ids []string) {
	emit(map[string]any{"type": "tests_not_run", "worker": worker, "count": len(ids), "ids": ids})
}

// Forwards a browser console line Hoot didn't emit itself (--console). test is the test
// running on that worker when the line was logged, empty outside of a test.
func Console(worker int, test, level, text string) {
	emit(map[string]any{"type": "console", "worker": worker, "test": test, "level": level, "text": text})
}

// Raw telemetry that isn't shaped like a UI action; the client either ignores it or
// aggregates it locally (e.g. worker_start's devtools URL).
func Info(event string, args ...any) {
	fields := kv(args)
	fields["type"] = event
	emit(fields)
}

// Like Step: emits a debug line immediately and returns a done func that emits a second one
// once elapsed time is known.
func Debug(event string, args ...any) func() {
	fields := kv(args)
	fields["type"] = "debug"
	fields["event"] = event
	emit(fields)
	start := time.Now()
	return func() {
		emit(map[string]any{
			"type":  "debug",
			"event": event,
			"ms":    time.Since(start).Milliseconds(),
		})
	}
}

func Warn(event string, args ...any)  { diagnostic("warn", event, args) }
func Error(event string, args ...any) { diagnostic("error", event, args) }

// Emits a warn/error condition tied to event, resolving its human label and pulling a
// message from the err or hint field.
func diagnostic(level, event string, args []any) {
	fields := kv(args)
	message := ""
	if v, ok := fields["err"]; ok {
		message = fmt.Sprint(v)
	} else if v, ok := fields["hint"]; ok {
		message = fmt.Sprint(v)
	}
	out := map[string]any{
		"type":    "diagnostic",
		"level":   level,
		"label":   label(event),
		"message": message,
	}
	if v, ok := fields["worker"]; ok {
		out["worker"] = v
	}
	emit(out)
}
