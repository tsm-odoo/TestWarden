package hoot

import (
	"encoding/json"
	"testing"

	"github.com/go-rod/rod/lib/proto"
)

func args(t *testing.T, raw string) []*proto.RuntimeRemoteObject {
	t.Helper()
	var out []*proto.RuntimeRemoteObject
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestArgsToPreviewText(t *testing.T) {
	cases := map[string]struct{ raw, want string }{
		"object": {
			`[{"type":"string","value":"x"},{"type":"object","className":"Object","description":"Object","preview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"a","type":"number","value":"1"},{"name":"b","type":"string","value":"hi"}]}}]`,
			`x {a: 1, b: "hi"}`,
		},
		"array overflow": {
			`[{"type":"object","subtype":"array","description":"Array(9)","preview":{"type":"object","subtype":"array","description":"Array(9)","overflow":true,"properties":[{"name":"0","type":"number","value":"1"},{"name":"1","type":"number","value":"2"}]}}]`,
			`[1, 2, …]`,
		},
		"nested and class": {
			`[{"type":"object","description":"Foo","preview":{"type":"object","description":"Foo","overflow":false,"properties":[{"name":"in","type":"object","value":"Object","valuePreview":{"type":"object","description":"Object","overflow":false,"properties":[{"name":"k","type":"boolean","value":"true"}]}}]}}]`,
			`Foo {in: {k: true}}`,
		},
		"error keeps description": {
			`[{"type":"object","subtype":"error","description":"Error: boom\n    at x","preview":{"type":"object","subtype":"error","description":"Error: boom","overflow":false,"properties":[]}}]`,
			"Error: boom\n    at x",
		},
		"no preview": {
			`[{"type":"object","description":"Object"}]`,
			"Object",
		},
	}
	for name, c := range cases {
		if got := ArgsToPreviewText(args(t, c.raw)); got != c.want {
			t.Errorf("%s: got %q, want %q", name, got, c.want)
		}
	}
}

func TestArgsToTextUnchanged(t *testing.T) {
	got := ArgsToText(args(t, `[{"type":"object","description":"Object","preview":{"type":"object","overflow":false,"properties":[]}}]`))
	if got != "Object" {
		t.Errorf("got %q", got)
	}
}
