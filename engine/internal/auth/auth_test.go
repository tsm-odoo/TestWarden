package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func server(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

func TestGetDatabase(t *testing.T) {
	srv := server(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/web/database/list" {
			t.Errorf("path %s", r.URL.Path)
		}
		w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":["first","second"]}`))
	})
	db, err := GetDatabase(srv.URL)
	if err != nil || db != "first" {
		t.Errorf("got %q, %v", db, err)
	}
	empty := server(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":[]}`))
	})
	if _, err := GetDatabase(empty.URL); err == nil || !strings.Contains(err.Error(), "no databases") {
		t.Errorf("empty: got %v", err)
	}
}

func TestAuthenticate(t *testing.T) {
	cases := map[string]struct {
		handler   http.HandlerFunc
		wantValue string
		wantErr   string
	}{
		"cookie": {
			handler: func(w http.ResponseWriter, r *http.Request) {
				http.SetCookie(w, &http.Cookie{Name: "session_id", Value: "from-cookie"})
				w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"session_id":"from-body"}}`))
			},
			wantValue: "from-cookie",
		},
		"result session_id": {
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"session_id":"from-body"}}`))
			},
			wantValue: "from-body",
		},
		"missing session": {
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
			},
			wantErr: "session_id not found (HTTP 200)",
		},
		"error with data.message": {
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"message":"Odoo Server Error","data":{"message":"Access Denied"}}}`))
			},
			wantErr: "authenticate: Access Denied",
		},
		"error without data.message": {
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"message":"Odoo Server Error"}}`))
			},
			wantErr: "authenticate: Odoo Server Error",
		},
	}
	for name, c := range cases {
		srv := server(t, c.handler)
		cookie, err := Authenticate(srv.URL, "db", "admin", "admin")
		if c.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("%s: got %v, %v", name, cookie, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if cookie.Name != "session_id" || cookie.Value != c.wantValue || cookie.Domain != "127.0.0.1" {
			t.Errorf("%s: got %+v", name, cookie)
		}
	}
}

func TestHostOnly(t *testing.T) {
	cases := map[string]string{
		"http://localhost:8069":          "localhost",
		"https://odoo.example.com":       "odoo.example.com",
		"http://localhost:8069/odoo/web": "localhost",
		"https://example.com/path":       "example.com",
		"localhost:8069":                 "localhost",
	}
	for input, want := range cases {
		if got := hostOnly(input); got != want {
			t.Errorf("%s: got %q", input, got)
		}
	}
}
