package runner

import (
	"context"
	"testing"
)

func TestExitCode(t *testing.T) {
	live := context.Background()
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	for _, code := range []int{0, 1, 2, 3} {
		if got := exitCode(live, code); got != code {
			t.Errorf("live %d: got %d", code, got)
		}
		if got := exitCode(cancelled, code); got != ExitInterrupted {
			t.Errorf("cancelled %d: got %d", code, got)
		}
	}
}
