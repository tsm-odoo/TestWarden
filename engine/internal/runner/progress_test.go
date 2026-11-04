package runner

import (
	"reflect"
	"testing"

	"test-warden/internal/hoot"
)

func testMeta(names ...string) (*hoot.Metadata, []string) {
	meta := &hoot.Metadata{TestByID: map[string]hoot.TestMeta{}}
	ids := make([]string, 0, len(names))
	for i, name := range names {
		id := string(rune('a' + i))
		meta.TestByID[id] = hoot.TestMeta{Name: name}
		ids = append(ids, id)
	}
	return meta, ids
}

func TestProgressPartialStalled(t *testing.T) {
	meta, ids := testMeta("t1", "t2", "t3", "t4", "t5")
	p := &progress{failed: map[string]bool{}}
	p.start("t1")
	p.start("t2")
	p.fail("t2")
	p.start("t3") // frozen in t3
	got := p.partial(0, ids, meta)
	if got.passed != 1 || got.failed != 1 {
		t.Errorf("tally = %d passed / %d failed, want 1 / 1", got.passed, got.failed)
	}
	if want := []string{"d", "e"}; !reflect.DeepEqual(got.notRun, want) {
		t.Errorf("notRun = %v, want %v", got.notRun, want)
	}
}

func TestProgressPartialAfterSuiteEnd(t *testing.T) {
	meta, ids := testMeta("t1", "t2", "t3")
	p := &progress{failed: map[string]bool{}}
	p.start("t1")
	p.start("t2")
	p.suiteEnded() // t2 finished, the worker died between suites
	got := p.partial(0, ids, meta)
	if got.passed != 2 || got.failed != 0 {
		t.Errorf("tally = %d passed / %d failed, want 2 / 0", got.passed, got.failed)
	}
	if want := []string{"c"}; !reflect.DeepEqual(got.notRun, want) {
		t.Errorf("notRun = %v, want %v", got.notRun, want)
	}
}

func TestProgressPartialNothingStarted(t *testing.T) {
	meta, ids := testMeta("t1", "t2")
	p := &progress{failed: map[string]bool{}}
	got := p.partial(0, ids, meta)
	if got.passed != 0 || got.failed != 0 || !reflect.DeepEqual(got.notRun, ids) {
		t.Errorf("got %+v", got)
	}
}
