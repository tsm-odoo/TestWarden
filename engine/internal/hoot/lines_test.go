package hoot

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/go-rod/rod/lib/proto"
)

func consoleArgs(values ...any) []*proto.RuntimeRemoteObject {
	raw := make([]map[string]any, 0, len(values))
	for _, value := range values {
		switch v := value.(type) {
		case string:
			raw = append(raw, map[string]any{"type": "string", "value": v})
		case int:
			raw = append(raw, map[string]any{"type": "number", "value": v, "description": strconv.Itoa(v)})
		}
	}
	data, _ := json.Marshal(raw)
	var out []*proto.RuntimeRemoteObject
	_ = json.Unmarshal(data, &out)
	return out
}

// hootLine mirrors Hoot's styledArguments: the prefix and first argument in one string,
// followed by the two style arguments.
func hootLine(first string, rest ...any) string {
	values := append([]any{"%c[HOOT]%c " + first, "color:#714b67;font-weight:bold", ""}, rest...)
	return ArgsToText(consoleArgs(values...))
}

func TestArgsToTextStripsStyles(t *testing.T) {
	got := hootLine(`Running test "web/foo"`)
	if strings.Contains(got, "%c") || strings.Contains(got, "color:") {
		t.Errorf("styles not stripped: %q", got)
	}
	if !strings.HasPrefix(got, `[HOOT] Running test "web/foo"`) {
		t.Errorf("got %q", got)
	}
}

func TestParseRunning(t *testing.T) {
	name, ok := ParseRunning(hootLine(`Running test "web/form/save > discard"`))
	if !ok || name != "web/form/save > discard" {
		t.Errorf("got %q, %v", name, ok)
	}
	if _, ok := ParseRunning("[HOOT] something else"); ok {
		t.Error("matched an unrelated line")
	}
}

func TestParseFailure(t *testing.T) {
	message := `Test "web/form/save" failed:` + "\n\nFailed assertion:\n\n1. [expect] expected 1 to be 2\nError: boom\n    at foo (form.test.js:12:3)"
	name, stack, ok := ParseFailure(hootLine(message))
	if !ok {
		t.Fatal("no match")
	}
	if name != "web/form/save" {
		t.Errorf("name: got %q", name)
	}
	if !strings.HasPrefix(stack, "Failed assertion:") || !strings.Contains(stack, "at foo (form.test.js:12:3)") {
		t.Errorf("stack: got %q", stack)
	}
	if strings.Contains(stack, "color:") {
		t.Errorf("stack keeps CSS: %q", stack)
	}
}

func TestParseFailureStripsInlineCSS(t *testing.T) {
	_, stack, ok := ParseFailure("[HOOT] Test \"a\" failed:\nline one color:#fff;font-weight:bold\nline two")
	if !ok {
		t.Fatal("no match")
	}
	if stack != "line one\nline two" {
		t.Errorf("got %q", stack)
	}
}

func TestIsAbortedFailure(t *testing.T) {
	_, stack, _ := ParseFailure(hootLine("Test \"a\" failed:\n\nFailed assertion:\n\n1. [aborted] test was aborted, results may not be relevant"))
	if !IsAbortedFailure(stack) {
		t.Error("aborted stack not detected")
	}
	if IsAbortedFailure("1. [expect] expected 1 to be 2") {
		t.Error("real failure reported as aborted")
	}
}

func TestParseSuiteDone(t *testing.T) {
	cases := map[string]struct {
		line string
		want SuiteDoneResult
	}{
		"passed only": {
			hootLine(`"web/form" ended`, "(passed:", 12, "/", "time:", 340, "ms)"),
			SuiteDoneResult{Suite: "web/form", Passed: 12, Ms: 340},
		},
		"with failures": {
			hootLine(`"web/form" ended`, "(passed:", 10, "/", "failed:", 2, "/", "time:", 512, "ms)"),
			SuiteDoneResult{Suite: "web/form", Passed: 10, Failed: 2, Ms: 512},
		},
	}
	for name, c := range cases {
		got, ok := ParseSuiteDone(c.line)
		if !ok || got != c.want {
			t.Errorf("%s: got %+v, %v from %q", name, got, ok, c.line)
		}
	}
}

func TestParseDone(t *testing.T) {
	got, ok := ParseDone("[HOOT] Passed 128 tests (642 assertions, total time: 12.3s)")
	if !ok || got != (DoneResult{Passed: 128}) {
		t.Errorf("passed: got %+v, %v", got, ok)
	}
	got, ok = ParseDone("[HOOT] Failed 3 tests (125 passed, total time: 12.3s)")
	if !ok || got != (DoneResult{Passed: 125, Failed: 3}) {
		t.Errorf("failed: got %+v, %v", got, ok)
	}
	if _, ok := ParseDone(hootLine(`Running test "a"`)); ok {
		t.Error("matched an unrelated line")
	}
}
