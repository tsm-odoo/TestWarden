package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
)

type Cookie struct {
	Name   string
	Value  string
	Domain string
}

// GetDatabase returns the name of the first database on the server.
func GetDatabase(serverURL string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "call",
		"id":      1,
		"params":  map[string]any{},
	})
	resp, err := http.Post(serverURL+"/web/database/list", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("database list: %w", err)
	}
	defer resp.Body.Close()
	var result struct {
		Result []string `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("database list: %w", err)
	}
	if len(result.Result) == 0 {
		return "", fmt.Errorf("database list: no databases found")
	}
	return result.Result[0], nil
}

// Authenticate logs in and returns the session cookie.
func Authenticate(serverURL, dbName, login, password string) (*Cookie, error) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "call",
		"id":      1,
		"params": map[string]any{
			"db":       dbName,
			"login":    login,
			"password": password,
		},
	})

	resp, err := http.Post(serverURL+"/web/session/authenticate", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("authenticate: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("authenticate: read response: %w", err)
	}

	var rpcResp struct {
		Error *struct {
			Data *struct {
				Message string `json:"message"`
			} `json:"data"`
			Message string `json:"message"`
		} `json:"error"`
		Result *struct {
			SessionID string `json:"session_id"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &rpcResp); err == nil && rpcResp.Error != nil {
		msg := rpcResp.Error.Message
		if rpcResp.Error.Data != nil && rpcResp.Error.Data.Message != "" {
			msg = rpcResp.Error.Data.Message
		}
		return nil, fmt.Errorf("authenticate: %s", msg)
	}

	domain := hostOnly(serverURL)

	for _, httpCookie := range resp.Cookies() {
		if httpCookie.Name == "session_id" {
			return &Cookie{Name: "session_id", Value: httpCookie.Value, Domain: domain}, nil
		}
	}
	if rpcResp.Result != nil && rpcResp.Result.SessionID != "" {
		return &Cookie{Name: "session_id", Value: rpcResp.Result.SessionID, Domain: domain}, nil
	}

	return nil, fmt.Errorf("authenticate: session_id not found (HTTP %d)", resp.StatusCode)
}

// Returns the sorted list of currently installed module names. Used both to detect a
// module install/uninstall for the metadata cache fingerprint, and to restrict the addon
// directories that get scanned for test files to ones that are actually installed (and so
// can actually show up in Hoot's metadata).
func ListInstalledModules(serverURL string, cookie *Cookie) ([]string, error) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "call",
		"params": map[string]any{
			"model":  "ir.module.module",
			"method": "search_read",
			"args": []any{
				[]any{[]any{"state", "=", "installed"}},
				[]string{"name"},
			},
			"kwargs": map[string]any{},
		},
	})
	req, err := http.NewRequest("POST", serverURL+"/web/dataset/call_kw", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("installed modules: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: cookie.Name, Value: cookie.Value})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("installed modules: %w", err)
	}
	defer resp.Body.Close()
	var rpcResp struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Result []struct {
			Name string `json:"name"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rpcResp); err != nil {
		return nil, fmt.Errorf("installed modules: decode: %w", err)
	}
	if rpcResp.Error != nil {
		return nil, fmt.Errorf("installed modules: %s", rpcResp.Error.Message)
	}
	names := make([]string, len(rpcResp.Result))
	for i, module := range rpcResp.Result {
		names[i] = module.Name
	}
	sort.Strings(names)
	return names, nil
}

func hostOnly(serverURL string) string {
	host := strings.TrimPrefix(serverURL, "https://")
	host = strings.TrimPrefix(host, "http://")
	if i := strings.IndexByte(host, '/'); i >= 0 {
		host = host[:i]
	}
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	return host
}
