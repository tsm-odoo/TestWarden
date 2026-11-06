package hoot

import (
	"net/url"
	"slices"
	"testing"
)

func query(t *testing.T, raw string) url.Values {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed.Query()
}

func TestWorkerURL(t *testing.T) {
	plain := WorkerURL("http://localhost:8069", "/web/tests", nil, false, false, false)
	q := query(t, plain)
	if q.Get("loglevel") != "2" || q.Get("manual") != "true" || q.Has("bail") || q.Has("debugTest") || q.Has("id") {
		t.Errorf("plain: %s", plain)
	}
	full := WorkerURL("http://localhost:8069", "/web/tests", []string{"0a1b2c3d", "deadbeef"}, true, true, true)
	q = query(t, full)
	if q.Get("loglevel") != "3" || q.Get("bail") != "1" || q.Get("debugTest") != "true" {
		t.Errorf("flags: %s", full)
	}
	if ids := q["id"]; !slices.Equal(ids, []string{"0a1b2c3d", "deadbeef"}) {
		t.Errorf("ids: got %v", ids)
	}
}

func TestMetaURL(t *testing.T) {
	got := MetaURL("http://localhost:8069", "/web/tests")
	q := query(t, got)
	if q.Get("loglevel") != "0" || q.Get("manual") != "true" || q.Has("id") {
		t.Errorf("got %s", got)
	}
}

func TestDebugURL(t *testing.T) {
	got := DebugURL("http://localhost:8069", "/web/tests", "deadbeef")
	q := query(t, got)
	if q.Get("id") != "deadbeef" || q.Get("debugTest") != "true" || q.Get("debug") != "assets" {
		t.Errorf("got %s", got)
	}
}

func TestIsMobilePreset(t *testing.T) {
	cases := map[string]bool{
		"/web/tests":                     false,
		"/web/tests?preset=mobile":       true,
		"/web/tests?preset=desktop":      false,
		"/web/tests?tag=a&preset=mobile": true,
	}
	for path, want := range cases {
		if got := IsMobilePreset(path); got != want {
			t.Errorf("%s: got %v", path, got)
		}
	}
}

func TestParseTestRef(t *testing.T) {
	cases := map[string]bool{
		"deadbeef":  false,
		"DEADBEEF":  false,
		"0a1b2c3d":  false,
		"deadbee":   true,
		"deadbeef0": true,
		"deadbeeg":  true,
		"web/form":  true,
	}
	for input, isName := range cases {
		ref := ParseTestRef(input)
		if ref.IsName() != isName || ref.String() != input {
			t.Errorf("%q: IsName=%v String=%q", input, ref.IsName(), ref.String())
		}
		if !isName && ref.ID() != input {
			t.Errorf("%q: ID=%q", input, ref.ID())
		}
	}
}
