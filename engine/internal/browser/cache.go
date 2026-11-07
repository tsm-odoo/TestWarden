// Response cache shared by all pages: intercepts requests through the CDP Fetch domain and
// serves repeated ones (bundles, test document, Hoot definitions) from memory.

package browser

import (
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
)

// Matches the model_names form field in get_definitions' multipart POST body.
var reModelNames = regexp.MustCompile(`name="model_names"\r?\n\r?\n(.*?)\r?\n--`)

// Subset of a /web/dataset/call_kw JSON-RPC body warden reads.
type callKwBody struct {
	Params struct {
		Kwargs struct {
			ModuleNames []string `json:"module_names"`
		} `json:"kwargs"`
	} `json:"params"`
}

var globalCache = &responseCache{
	entries: make(map[string]*cachedEntry),
	byPath:  make(map[string]*cachedEntry),
}

type cachedEntry struct {
	status  int
	headers []*proto.FetchHeaderEntry
	body    []byte
	path    string // under which cacheServer serves it
}

type responseCache struct {
	mu      sync.Mutex
	entries map[string]*cachedEntry
	byPath  map[string]*cachedEntry
}

func (cache *responseCache) get(key string) (*cachedEntry, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	entry, ok := cache.entries[key]
	return entry, ok
}

func (cache *responseCache) setIfAbsent(key string, entry *cachedEntry) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if _, exists := cache.entries[key]; exists {
		return
	}
	entry.path = "/" + strconv.Itoa(len(cache.entries))
	cache.entries[key] = entry
	cache.byPath[entry.path] = entry
}

func (cache *responseCache) getByPath(path string) (*cachedEntry, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	entry, ok := cache.byPath[path]
	return entry, ok
}

// Serves the cached responses over plain HTTP on a loopback port. A cache hit is sent there
// with Fetch.continueRequest's url override, so Chrome streams the body from this server
// instead of receiving it inside a Fetch.fulfillRequest message: tens of MB per worker and
// page load, base64 encoded into JSON on our side and decoded again on Chrome's.
var cacheServer struct {
	once sync.Once
	url  string // "" if it could not start, hits are then fulfilled through CDP
}

func cacheServerURL() string {
	cacheServer.once.Do(func() {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return
		}
		cacheServer.url = "http://" + listener.Addr().String()
		go http.Serve(listener, http.HandlerFunc(serveCached))
	})
	return cacheServer.url
}

func serveCached(writer http.ResponseWriter, request *http.Request) {
	entry, ok := globalCache.getByPath(request.URL.Path)
	if !ok {
		http.NotFound(writer, request)
		return
	}
	for _, header := range entry.headers {
		writer.Header().Add(header.Name, header.Value)
	}
	writer.WriteHeader(entry.status)
	writer.Write(entry.body)
}

func isLoopback(serverURL string) bool {
	parsed, err := url.Parse(serverURL)
	if err != nil {
		return false
	}
	if parsed.Hostname() == "localhost" {
		return true
	}
	ip := net.ParseIP(parsed.Hostname())
	return ip != nil && ip.IsLoopback()
}

// Force aggressive Cache-Control headers on all responses to speed up reloads.
func SetupPageCache(page *rod.Page, serverURL string) error {
	_ = proto.ServiceWorkerEnable{}.Call(page)
	_ = proto.ServiceWorkerUnregister{ScopeURL: serverURL}.Call(page)
	if err := (proto.FetchEnable{}).Call(page); err != nil {
		return err
	}
	// Sending a request for a remote server to a loopback address could be blocked by
	// Chrome's local network access checks, so such hits are fulfilled through CDP.
	serveURL := ""
	if isLoopback(serverURL) {
		serveURL = cacheServerURL()
	}
	go page.EachEvent(func(e *proto.FetchRequestPaused) bool {
		go handleFetchPaused(page, e, serveURL)
		return false
	})()
	return nil
}

// Returns the key under which the response should be stored/looked up (or "" if
// uncacheable). The test Document is keyed by path only; get_definitions and
// all_dependencies are keyed by their POST payload since the URL itself never changes
// across different bodies but hoot still needs the actual result.
//
// Script and Stylesheet GETs are cached too: workers beyond the first run in their own
// incognito context, so Chrome's own HTTP cache isn't shared between them, and every
// worker would otherwise refetch the same large bundles itself. The initial metadata
// fetch (loadMeta) warms this cache for every worker before any of them navigate, so by
// the time workers run concurrently these are all cache hits.
func cacheKey(e *proto.FetchRequestPaused) (key string) {
	if e.ResourceType == proto.NetworkResourceTypeDocument {
		if !strings.Contains(e.Request.URL, "/web/tests") {
			return ""
		}
		if queryStart := strings.Index(e.Request.URL, "?"); queryStart != -1 {
			return e.Request.URL[:queryStart]
		}
		return e.Request.URL
	}
	if e.Request.Method == "GET" {
		return e.Request.URL
	}
	if e.Request.Method != "POST" {
		return ""
	}
	if strings.HasSuffix(e.Request.URL, "/web/model/get_definitions") {
		if matches := reModelNames.FindStringSubmatch(e.Request.PostData); matches != nil {
			return e.Request.URL + "#" + matches[1]
		}
	}
	if strings.HasSuffix(e.Request.URL, "/all_dependencies") {
		var body callKwBody
		if json.Unmarshal([]byte(e.Request.PostData), &body) == nil && len(body.Params.Kwargs.ModuleNames) > 0 {
			return e.Request.URL + "#" + strings.Join(body.Params.Kwargs.ModuleNames, ",")
		}
	}
	return ""
}

func handleFetchPaused(page *rod.Page, e *proto.FetchRequestPaused, serveURL string) {
	key := cacheKey(e)

	// Request stage: no response yet, serve from cache if possible.
	if e.ResponseStatusCode == nil {
		if key != "" {
			if entry, hit := globalCache.get(key); hit {
				if serveURL != "" {
					_ = proto.FetchContinueRequest{RequestID: e.RequestID, URL: serveURL + entry.path}.Call(page)
					return
				}
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
	if key != "" && status >= 200 && status < 300 {
		if result, err := (proto.FetchGetResponseBody{RequestID: e.RequestID}).Call(page); err == nil {
			var bodyBytes []byte
			if result.Base64Encoded {
				bodyBytes, _ = base64.StdEncoding.DecodeString(result.Body)
			} else {
				bodyBytes = []byte(result.Body)
			}
			globalCache.setIfAbsent(key, &cachedEntry{
				status:  status,
				headers: patchHeaders(stripEncodingHeaders(e.ResponseHeaders), "public, max-age=31536000"),
				body:    bodyBytes,
			})
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
		for i, header := range out {
			if strings.EqualFold(header.Name, name) {
				out[i] = &proto.FetchHeaderEntry{Name: header.Name, Value: value}
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
