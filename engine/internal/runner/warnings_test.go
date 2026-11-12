package runner

import (
	"bufio"
	"encoding/json"
	"os"
	"testing"

	"test-warden/internal/hoot"
)

// Replays a worker's warnings and Hoot failures through the tracker, then sends its failure
// events and done event through drain. Returns drain's tally and the test_fail lines it wrote.
func drainWorker(t *testing.T, result hoot.DoneResult, steps func(w *warnings, fail func(string))) (passed, failed, testFails int) {
	t.Helper()
	w := newWarnings()
	out := make(chan event, 64)
	steps(w, func(name string) {
		out <- event{kind: kindFailure, name: name}
	})
	result = w.adjust(result)
	out <- event{kind: kindDone, passed: result.Passed, failed: result.Failed}
	close(out)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout := os.Stdout
	os.Stdout = writer
	passed, failed = drain(out, func() {})
	os.Stdout = stdout
	writer.Close()
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		var line struct{ Type string }
		if json.Unmarshal(scanner.Bytes(), &line) == nil && line.Type == "test_fail" {
			testFails++
		}
	}
	return passed, failed, testFails
}

func TestWarningsCount(t *testing.T) {
	cases := []struct {
		name         string
		result       hoot.DoneResult
		steps        func(w *warnings, fail func(string))
		passed       int
		failed       int
		failureLines int
	}{
		{
			name:   "several warnings on a passed test",
			result: hoot.DoneResult{Passed: 3},
			steps: func(w *warnings, fail func(string)) {
				w.start("t1")
				for range 3 {
					w.warn()
					fail("t1")
				}
				w.start("t2")
				w.start("t3")
			},
			passed: 2, failed: 1, failureLines: 3,
		},
		{
			name:   "warning on a test Hoot also failed",
			result: hoot.DoneResult{Passed: 1, Failed: 1},
			steps: func(w *warnings, fail func(string)) {
				w.start("t1")
				w.warn()
				fail("t1")
				w.hootFailed("t1")
				fail("t1")
				w.start("t2")
			},
			passed: 1, failed: 1, failureLines: 2,
		},
		{
			name:   "warnings on two passed tests",
			result: hoot.DoneResult{Passed: 3},
			steps: func(w *warnings, fail func(string)) {
				w.start("t1")
				w.warn()
				fail("t1")
				w.start("t2")
				w.start("t3")
				w.warn()
				fail("t3")
				w.warn()
				fail("t3")
			},
			passed: 1, failed: 2, failureLines: 3,
		},
		{
			name:   "multi repetitions of one test",
			result: hoot.DoneResult{Passed: 3, Failed: 1},
			steps: func(w *warnings, fail func(string)) {
				for rep := range 4 {
					w.start("t1")
					if rep == 1 || rep == 2 {
						w.warn()
						fail("t1")
					}
					if rep == 2 || rep == 3 {
						w.hootFailed("t1")
						fail("t1")
					}
				}
			},
			passed: 2, failed: 2, failureLines: 4,
		},
		{
			name:   "Hoot failure of another test is not matched to the running one",
			result: hoot.DoneResult{Passed: 1, Failed: 1},
			steps: func(w *warnings, fail func(string)) {
				w.start("t1")
				w.start("t2")
				w.warn()
				fail("t2")
				w.hootFailed("t1")
				fail("t1")
			},
			passed: 0, failed: 2, failureLines: 2,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			total := c.result.Passed + c.result.Failed
			passed, failed, failures := drainWorker(t, c.result, c.steps)
			if passed != c.passed || failed != c.failed {
				t.Errorf("got %d passed / %d failed, want %d / %d", passed, failed, c.passed, c.failed)
			}
			if passed+failed != total {
				t.Errorf("passed + failed = %d, want total %d", passed+failed, total)
			}
			if failures != c.failureLines {
				t.Errorf("got %d failure events, want %d", failures, c.failureLines)
			}
		})
	}
}

func TestWarningsBeforeAnyTest(t *testing.T) {
	w := newWarnings()
	w.hootFailed("t1")
	if got := w.adjust(hoot.DoneResult{Passed: 1}); got.Passed != 1 || got.Failed != 0 {
		t.Errorf("got %+v", got)
	}
}
