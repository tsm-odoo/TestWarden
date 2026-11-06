package browser

import (
	"testing"

	"github.com/go-rod/rod/lib/proto"
)

func paused(resourceType proto.NetworkResourceType, method, url, body string) *proto.FetchRequestPaused {
	return &proto.FetchRequestPaused{
		ResourceType: resourceType,
		Request:      &proto.NetworkRequest{Method: method, URL: url, PostData: body},
	}
}

func TestCacheKey(t *testing.T) {
	const base = "http://localhost:8069"
	multipart := "--b\r\nContent-Disposition: form-data; name=\"model_names\"\r\n\r\n[\"res.partner\",\"res.users\"]\r\n--b--\r\n"
	cases := map[string]struct {
		event *proto.FetchRequestPaused
		want  string
	}{
		"test document without query": {
			paused(proto.NetworkResourceTypeDocument, "GET", base+"/web/tests?id=deadbeef&loglevel=2", ""),
			base + "/web/tests",
		},
		"test document plain": {
			paused(proto.NetworkResourceTypeDocument, "GET", base+"/web/tests/livechat", ""),
			base + "/web/tests/livechat",
		},
		"other document": {
			paused(proto.NetworkResourceTypeDocument, "GET", base+"/odoo", ""),
			"",
		},
		"script GET": {
			paused(proto.NetworkResourceTypeScript, "GET", base+"/web/assets/web.assets_unit_tests.min.js?v=1", ""),
			base + "/web/assets/web.assets_unit_tests.min.js?v=1",
		},
		"get_definitions": {
			paused(proto.NetworkResourceTypeFetch, "POST", base+"/web/model/get_definitions", multipart),
			base + "/web/model/get_definitions#[\"res.partner\",\"res.users\"]",
		},
		"get_definitions without model_names": {
			paused(proto.NetworkResourceTypeFetch, "POST", base+"/web/model/get_definitions", "--b--"),
			"",
		},
		"all_dependencies": {
			paused(proto.NetworkResourceTypeFetch, "POST", base+"/web/dataset/call_kw/ir.module.module/all_dependencies",
				`{"params":{"kwargs":{"module_names":["web","mail"]}}}`),
			base + "/web/dataset/call_kw/ir.module.module/all_dependencies#web,mail",
		},
		"other POST": {
			paused(proto.NetworkResourceTypeFetch, "POST", base+"/web/dataset/call_kw/res.partner/read", `{}`),
			"",
		},
		"other method": {
			paused(proto.NetworkResourceTypeFetch, "PUT", base+"/web/assets/x.js", ""),
			"",
		},
	}
	for name, c := range cases {
		if got := cacheKey(c.event); got != c.want {
			t.Errorf("%s: got %q, want %q", name, got, c.want)
		}
	}
}

func headerMap(headers []*proto.FetchHeaderEntry) map[string]string {
	out := make(map[string]string, len(headers))
	for _, header := range headers {
		out[header.Name] = header.Value
	}
	return out
}

func TestStripEncodingHeaders(t *testing.T) {
	input := []*proto.FetchHeaderEntry{
		{Name: "content-encoding", Value: "gzip"},
		{Name: "Content-Length", Value: "42"},
		{Name: "Content-Type", Value: "text/javascript"},
	}
	got := headerMap(stripEncodingHeaders(input))
	if len(got) != 1 || got["Content-Type"] != "text/javascript" {
		t.Errorf("got %v", got)
	}
	if len(input) != 3 {
		t.Error("input modified")
	}
}

func TestPatchHeaders(t *testing.T) {
	input := []*proto.FetchHeaderEntry{
		{Name: "cache-control", Value: "no-cache"},
		{Name: "Content-Type", Value: "text/javascript"},
	}
	got := headerMap(patchHeaders(input, "max-age=3600"))
	if got["cache-control"] != "max-age=3600" || got["X-Warden-Cache"] != "TRUE" || got["Content-Type"] != "text/javascript" || len(got) != 3 {
		t.Errorf("got %v", got)
	}
	if len(input) != 2 || input[0].Value != "no-cache" || input[1].Value != "text/javascript" {
		t.Errorf("input modified: %v", headerMap(input))
	}
}
