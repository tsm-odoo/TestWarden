package log

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// emit writes a single JSON line to stderr.
func emit(level, event string, args []any) {
	m := kv(args)
	m["level"] = level
	m["event"] = event
	b, _ := json.Marshal(m)
	fmt.Fprintf(os.Stderr, "%s\n", b)
}

// kv converts alternating key/value args into a map.
// error values are converted to their string message so json.Marshal doesn't emit {}.
func kv(args []any) map[string]any {
	m := make(map[string]any, len(args)/2+2)
	for i := 0; i+1 < len(args); i += 2 {
		if k, ok := args[i].(string); ok {
			v := args[i+1]
			if err, ok := v.(error); ok {
				v = err.Error()
			}
			m[k] = v
		}
	}
	return m
}

func cloneArgs(args []any) []any {
	c := make([]any, len(args))
	copy(c, args)
	return c
}

// Step emits event with status=start, returns a done func that emits status=done and elapsed ms.
func Step(event string, args ...any) func() {
	emit("info", event, append(cloneArgs(args), "status", "start"))
	start := time.Now()
	return func() {
		emit("info", event, append(cloneArgs(args), "status", "done", "ms", time.Since(start).Milliseconds()))
	}
}

func Info(event string, args ...any)  { emit("info", event, args) }
func Warn(event string, args ...any)  { emit("warn", event, args) }
func Error(event string, args ...any) { emit("error", event, args) }
