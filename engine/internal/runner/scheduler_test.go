package runner

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"test-warden/internal/hoot"
)

func schedulerMeta() *hoot.Metadata {
	tests := map[string]hoot.TestMeta{
		"aaaaaaa1": {Name: "web/form/save record"},
		"aaaaaaa2": {Name: "web/form/discard record"},
		"aaaaaaa3": {Name: "web/list/sort column", Tags: []string{"focus required"}},
		"aaaaaaa4": {Name: "web/list/skipped one", Tags: []string{"skip"}},
		"aaaaaaa5": {Name: "web/list/mobile only", Tags: []string{"mobile"}},
		"aaaaaaa6": {Name: "web/list/desktop only", Tags: []string{"desktop"}},
		"bbbbbbb1": {Name: "mail/thread/post message"},
	}
	suiteTest := func(id string) hoot.SuiteTest {
		return hoot.SuiteTest{ID: id, Name: tests[id].Name, Tags: tests[id].Tags}
	}
	return &hoot.Metadata{
		TestByID: tests,
		SuiteByID: map[string]hoot.SuiteMeta{
			"s1": {Name: "@web"},
			"s2": {Name: "@web/list"},
			"s3": {Name: "@mail"},
		},
		TestsBySuiteID: map[string][]hoot.SuiteTest{
			"s1": {suiteTest("aaaaaaa1"), suiteTest("aaaaaaa2"), suiteTest("aaaaaaa3"), suiteTest("aaaaaaa4"), suiteTest("aaaaaaa5"), suiteTest("aaaaaaa6")},
			"s2": {suiteTest("aaaaaaa3"), suiteTest("aaaaaaa4"), suiteTest("aaaaaaa5"), suiteTest("aaaaaaa6")},
			"s3": {suiteTest("bbbbbbb1")},
		},
	}
}

func sorted(ids []string) []string {
	out := slices.Clone(ids)
	slices.Sort(out)
	return out
}

func TestFilterIDsByTest(t *testing.T) {
	meta := schedulerMeta()
	cases := map[string]struct {
		test    string
		want    []string
		wantErr string
	}{
		"by id":             {test: "aaaaaaa2", want: []string{"aaaaaaa2"}},
		"unknown id":        {test: "ffffffff", wantErr: "test not found"},
		"unique partial":    {test: "DISCARD", want: []string{"aaaaaaa2"}},
		"unknown name":      {test: "nothing like it", wantErr: "test not found"},
		"ambiguous partial": {test: "record", wantErr: "ambiguous"},
	}
	for name, c := range cases {
		got, err := FilterIDs(meta, nil, c.test, false)
		if c.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("%s: got %v, %v", name, got, err)
			}
			continue
		}
		if err != nil || !slices.Equal(got, c.want) {
			t.Errorf("%s: got %v, %v", name, got, err)
		}
	}
}

func TestFilterIDsBySuite(t *testing.T) {
	meta := schedulerMeta()
	got, err := FilterIDs(meta, []string{"@web", "@web/list", "@mail"}, "", false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"aaaaaaa1", "aaaaaaa2", "aaaaaaa3", "aaaaaaa6", "bbbbbbb1"}
	if !slices.Equal(sorted(got), want) {
		t.Errorf("desktop: got %v", got)
	}
	got, err = FilterIDs(meta, []string{"@web/list"}, "", true)
	if err != nil || !slices.Equal(sorted(got), []string{"aaaaaaa3", "aaaaaaa5"}) {
		t.Errorf("mobile: got %v, %v", got, err)
	}
	if _, err := FilterIDs(meta, []string{"@nope"}, "", false); err == nil || !strings.Contains(err.Error(), "unknown suite") {
		t.Errorf("unknown suite: got %v", err)
	}
}

func TestFilterIDsAll(t *testing.T) {
	meta := schedulerMeta()
	got, _ := FilterIDs(meta, nil, "", false)
	if want := []string{"aaaaaaa1", "aaaaaaa2", "aaaaaaa3", "aaaaaaa6", "bbbbbbb1"}; !slices.Equal(sorted(got), want) {
		t.Errorf("desktop: got %v", got)
	}
	got, _ = FilterIDs(meta, nil, "", true)
	if want := []string{"aaaaaaa1", "aaaaaaa2", "aaaaaaa3", "aaaaaaa5", "bbbbbbb1"}; !slices.Equal(sorted(got), want) {
		t.Errorf("mobile: got %v", got)
	}
}

func ids(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("%08x", i)
	}
	return out
}

func checkSplit(t *testing.T, name string, input []string, splits [][]string) {
	t.Helper()
	var all []string
	for _, split := range splits {
		if len(split) == 0 {
			t.Errorf("%s: empty split", name)
		}
		all = append(all, split...)
	}
	if !slices.Equal(sorted(all), sorted(input)) {
		t.Errorf("%s: ids not covered exactly once", name)
	}
}

func TestSplitTests(t *testing.T) {
	cases := map[string]struct {
		count, workers, minLoad, wantSplits int
	}{
		"even":                    {count: 100, workers: 4, minLoad: 0, wantSplits: 4},
		"uneven":                  {count: 10, workers: 4, minLoad: 0, wantSplits: 4},
		"fewer tests":             {count: 2, workers: 4, minLoad: 0, wantSplits: 2},
		"minLoad caps workers":    {count: 10, workers: 4, minLoad: 5, wantSplits: 2},
		"minLoad above count":     {count: 3, workers: 4, minLoad: 5, wantSplits: 1},
		"minLoad already reached": {count: 40, workers: 4, minLoad: 5, wantSplits: 4},
	}
	for name, c := range cases {
		input := ids(c.count)
		splits := SplitTests(input, c.workers, c.minLoad)
		if len(splits) != c.wantSplits {
			t.Errorf("%s: got %d splits", name, len(splits))
		}
		checkSplit(t, name, input, splits)
	}
	if splits := SplitTests(nil, 4, 0); splits != nil {
		t.Errorf("empty: got %v", splits)
	}
}

func TestPartitionFocusRequired(t *testing.T) {
	meta := schedulerMeta()
	if !requiresFocus(meta, "aaaaaaa3") || requiresFocus(meta, "aaaaaaa1") || requiresFocus(meta, "unknown0") {
		t.Error("requiresFocus")
	}
	focus, other := partitionFocusRequired(meta, []string{"aaaaaaa2", "aaaaaaa3", "aaaaaaa1"})
	if !slices.Equal(focus, []string{"aaaaaaa3"}) || !slices.Equal(other, []string{"aaaaaaa2", "aaaaaaa1"}) {
		t.Errorf("got %v / %v", focus, other)
	}
}
