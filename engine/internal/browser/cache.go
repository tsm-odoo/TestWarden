package browser

import (
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
)

// Matches the model_names form field in get_definitions' multipart POST body.
var reModelNames = regexp.MustCompile(`name="model_names"\r?\n\r?\n(.*?)\r?\n--`)

// callKwBody covers the subset of a /web/dataset/call_kw JSON-RPC body warden reads.
type callKwBody struct {
	Params struct {
		Kwargs struct {
			ModuleNames []string `json:"module_names"`
		} `json:"kwargs"`
	} `json:"params"`
}

var globalCache = &responseCache{
	entries: make(map[string]cachedEntry),
	pending: make(map[string]chan struct{}),
}

type cachedEntry struct {
	status     int
	statusText string
	headers    []*proto.FetchHeaderEntry
	body       []byte
}

type responseCache struct {
	mu      sync.Mutex
	entries map[string]cachedEntry
	pending map[string]chan struct{}
}

func (c *responseCache) get(key string) (cachedEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	return entry, ok
}

func (c *responseCache) setIfAbsent(key string, entry cachedEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.entries[key]; !exists {
		c.entries[key] = entry
	}
}

// How long a coalesced key can stay claimed but incomplete.
// Owned by the cache (scheduled the instant a key becomes pending), not by each follower
// -- this guarantees the pending slot releases within this window even if the leader's
// underlying CDP request never reaches a response stage.
const pendingWaitTimeout = 5 * time.Second

// Returns (entry, true) on a cache hit -- either immediately, or after waiting for
// an in-flight request for the same key to finish or time out. On a miss with nobody in
// flight, the caller becomes responsible for fetching the response and calling complete();
func (c *responseCache) claim(key string) (cachedEntry, bool) {
	c.mu.Lock()
	if entry, ok := c.entries[key]; ok {
		c.mu.Unlock()
		return entry, true
	}
	if wait, exists := c.pending[key]; exists {
		c.mu.Unlock()
		<-wait
		c.mu.Lock()
		entry, ok := c.entries[key]
		c.mu.Unlock()
		return entry, ok
	}
	c.pending[key] = make(chan struct{})
	c.mu.Unlock()
	time.AfterFunc(pendingWaitTimeout, func() { c.complete(key, cachedEntry{}, false) })
	return cachedEntry{}, false
}

// Stores entry (only if ok, e.g. a 2xx status) and releases anyone waiting on
// key (idempotent).
func (c *responseCache) complete(key string, entry cachedEntry, ok bool) {
	c.mu.Lock()
	if ok {
		c.entries[key] = entry
	}
	wait := c.pending[key]
	delete(c.pending, key)
	c.mu.Unlock()
	if wait != nil {
		close(wait)
	}
}

// Force aggressive Cache-Control headers on all responses to speed up reloads.
func SetupPageCache(page *rod.Page, serverURL string) error {
	_ = proto.ServiceWorkerEnable{}.Call(page)
	_ = proto.ServiceWorkerUnregister{ScopeURL: serverURL}.Call(page)
	if err := (proto.FetchEnable{}).Call(page); err != nil {
		return err
	}
	go page.EachEvent(func(e *proto.FetchRequestPaused) bool {
		go handleFetchPaused(page, e)
		return false
	})()
	return nil
}

// Returns the key under which the response should be stored/looked up (or "" if
// uncacheable), and whether it's worth having other in-flight requests for the same key
// wait on this one rather than just racing to store/reuse the result
// opportunistically once available. The test Document is keyed by path only;
// get_definitions and all_dependencies are keyed by their POST payload since the URL
// itself never changes across different bodies but hoot still needs the actual result.
//
// Script and Stylesheet GETs (where the multi-MB test bundles live) are coalesced: workers
// beyond #0 run in their own incognito context, so Chrome's own HTTP cache isn't shared
// between them, and every worker would otherwise refetch the same large bundles in
// parallel. Coalescing isn't extended to other GET-able types (Font, Image, ...) because
// CDP gives no way to tell in advance which requests might get cancelled/superseded by the
// browser (e.g. a preloaded font) rather than completing normally.
func cacheKey(e *proto.FetchRequestPaused) (key string, coalesce bool) {
	if e.ResourceType == proto.NetworkResourceTypeDocument {
		if !strings.Contains(e.Request.URL, "/web/tests") {
			return "", false
		}
		if queryStart := strings.Index(e.Request.URL, "?"); queryStart != -1 {
			return e.Request.URL[:queryStart], false
		}
		return e.Request.URL, false
	}
	if e.Request.Method == "GET" {
		coalesce := e.ResourceType == proto.NetworkResourceTypeScript || e.ResourceType == proto.NetworkResourceTypeStylesheet
		return e.Request.URL, coalesce
	}
	if e.Request.Method != "POST" {
		return "", false
	}
	if strings.HasSuffix(e.Request.URL, "/web/model/get_definitions") {
		if matches := reModelNames.FindStringSubmatch(e.Request.PostData); matches != nil {
			return e.Request.URL + "#" + matches[1], false
		}
	}
	if strings.HasSuffix(e.Request.URL, "/all_dependencies") {
		var body callKwBody
		if json.Unmarshal([]byte(e.Request.PostData), &body) == nil && len(body.Params.Kwargs.ModuleNames) > 0 {
			return e.Request.URL + "#" + strings.Join(body.Params.Kwargs.ModuleNames, ","), false
		}
	}
	return "", false
}

func handleFetchPaused(page *rod.Page, e *proto.FetchRequestPaused) {
	key, coalesce := cacheKey(e)

	// Request stage: no response yet, serve from cache if possible.
	if e.ResponseStatusCode == nil {
		if key != "" {
			var entry cachedEntry
			var hit bool
			if coalesce {
				entry, hit = globalCache.claim(key)
			} else {
				entry, hit = globalCache.get(key)
			}
			if hit {
				_ = proto.FetchFulfillRequest{
					RequestID:       e.RequestID,
					ResponseCode:    entry.status,
					ResponseHeaders: entry.headers,
					Body:            entry.body,
				}.Call(page)
				return
			}
		}
		_ = proto.FetchContinueRequest{
			RequestID:         e.RequestID,
			InterceptResponse: true,
		}.Call(page)
		return
	}

	// Response stage: explicitly cache the requests matched above, then continue with
	// patched Cache-Control headers so the browser caches everything else itself.
	status := *e.ResponseStatusCode
	if key != "" {
		ok := false
		var entry cachedEntry
		if status >= 200 && status < 300 {
			if result, err := (proto.FetchGetResponseBody{RequestID: e.RequestID}).Call(page); err == nil {
				var bodyBytes []byte
				if result.Base64Encoded {
					bodyBytes, _ = base64.StdEncoding.DecodeString(result.Body)
				} else {
					bodyBytes = []byte(result.Body)
				}
				entry = cachedEntry{
					status:     status,
					statusText: e.ResponseStatusText,
					headers:    e.ResponseHeaders,
					body:       bodyBytes,
				}
				ok = true
			}
		}
		if coalesce {
			globalCache.complete(key, entry, ok)
		} else if ok {
			globalCache.setIfAbsent(key, entry)
		}
	}
	proto.FetchContinueResponse{
		RequestID:       e.RequestID,
		ResponseCode:    &status,
		ResponseHeaders: patchHeaders(e.ResponseHeaders, "public, max-age=31536000"),
		ResponsePhrase:  e.ResponseStatusText,
	}.Call(page)
}

// Drops Content-Encoding/Content-Length from a copy of headers. Fetch.getResponseBody
// returns the already-decoded body, but the original response headers still describe the
// encoded form.
func stripEncodingHeaders(headers []*proto.FetchHeaderEntry) []*proto.FetchHeaderEntry {
	out := make([]*proto.FetchHeaderEntry, 0, len(headers))
	for _, header := range headers {
		if strings.EqualFold(header.Name, "Content-Encoding") || strings.EqualFold(header.Name, "Content-Length") {
			continue
		}
		out = append(out, header)
	}
	return out
}

func patchHeaders(headers []*proto.FetchHeaderEntry, cacheControl string) []*proto.FetchHeaderEntry {
	out := make([]*proto.FetchHeaderEntry, len(headers))
	copy(out, headers)
	overrides := [][2]string{{"Cache-Control", cacheControl}, {"X-Warden-Cache", "TRUE"}}
	for _, override := range overrides {
		name, value := override[0], override[1]
		found := false
		for _, header := range out {
			if strings.EqualFold(header.Name, name) {
				header.Value = value
				found = true
				break
			}
		}
		if !found {
			out = append(out, &proto.FetchHeaderEntry{Name: name, Value: value})
		}
	}
	return out
}
