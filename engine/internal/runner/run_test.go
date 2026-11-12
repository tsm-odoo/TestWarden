package runner

import (
	"context"
	"errors"
	"testing"

	"test-warden/internal/hoot"
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

func TestWaitCacheWarmCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	meta, err := waitCacheWarm(ctx, make(chan metaFetchResult))
	if meta != nil || !errors.Is(err, context.Canceled) {
		t.Errorf("got %v, %v, want nil, context.Canceled", meta, err)
	}
}

func TestWaitCacheWarmResult(t *testing.T) {
	warmCh := make(chan metaFetchResult, 1)
	want := &hoot.Metadata{}
	warmCh <- metaFetchResult{meta: want}
	meta, err := waitCacheWarm(context.Background(), warmCh)
	if meta != want || err != nil {
		t.Errorf("got %v, %v, want the fetched metadata", meta, err)
	}
}
