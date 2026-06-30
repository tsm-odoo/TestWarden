package runner

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"

	"test-warden/internal/auth"
	"test-warden/internal/hoot"
	"test-warden/internal/log"
)

type eventKind string

const (
	kindFailure eventKind = "failure"
	kindDone    eventKind = "done"
	kindError   eventKind = "error"
)

type event struct {
	kind   eventKind
	id     string // test ID (failure)
	name   string // test name (failure)
	stack  string // console trace (failure) or error message (error)
	url    string // debug URL (failure)
	passed int
	failed int
	worker int
}

type workerConfig struct {
	serverURL string
	suitePath string
	cookie    *auth.Cookie
	meta      *hoot.Metadata
	failFast  bool
	browserWS string // WebSocket URL of the browser, used to build devtools URLs
	debugTest bool   // add &debugTest=true to worker URL (single test, visible mode)
}

// setupPage creates and configures a new browser page for a worker.
// Logs worker_start with the devtools URL. Caller must close the page when done.
func setupPage(
	ctx context.Context,
	browser *rod.Browser,
	workerID int,
	testIDs []string,
	cfg workerConfig,
) (*rod.Page, error) {
	page, err := browser.Page(proto.TargetCreateTarget{URL: "about:blank"})
	if err != nil {
		return nil, fmt.Errorf("create page: %w", err)
	}

	cookieErr := proto.NetworkSetCookies{
		Cookies: []*proto.NetworkCookieParam{{
			Name:   cfg.cookie.Name,
			Value:  cfg.cookie.Value,
			Domain: cfg.cookie.Domain,
			Path:   "/",
		}},
	}.Call(page)
	if cookieErr != nil {
		page.Close()
		return nil, fmt.Errorf("set cookie: %w", cookieErr)
	}

	devtoolsURL := ""
	if u, err := url.Parse(cfg.browserWS); err == nil {
		devtoolsURL = fmt.Sprintf("http://%s/devtools/inspector.html?ws=%s/devtools/page/%s",
			u.Host, u.Host, page.TargetID)
	}

	if _, err := page.Activate(); err != nil {
		page.Close()
		return nil, fmt.Errorf("activate page: %w", err)
	}
	if err := (proto.EmulationSetFocusEmulationEnabled{Enabled: true}.Call(page)); err != nil {
		page.Close()
		return nil, fmt.Errorf("enable focus emulation: %w", err)
	}

	log.Info("worker_start", "worker", workerID, "tests", len(testIDs), "devtools", devtoolsURL)
	return page, nil
}

// execPage navigates page to the worker URL and runs one full test cycle.
// All events (failures, done) are sent on out.
func execPage(
	ctx context.Context,
	page *rod.Page,
	workerID int,
	testIDs []string,
	cfg workerConfig,
	out chan<- event,
) error {
	workerURL := hoot.WorkerURL(cfg.serverURL, cfg.suitePath, testIDs, cfg.failFast, cfg.debugTest)
	if err := page.Navigate(workerURL); err != nil {
		return fmt.Errorf("navigate: %w", err)
	}
	if err := (proto.RuntimeEnable{}.Call(page)); err != nil {
		return fmt.Errorf("enable runtime: %w", err)
	}
	done := make(chan hoot.DoneResult, 1)
	// EachEvent returns a wait function that must be called (in a goroutine) to
	// start pumping events. Calling it with defer would start the loop too late.
	go page.EachEvent(func(e *proto.RuntimeConsoleAPICalled) bool {
		text := argsToText(e.Args)
		if name, ok := hoot.ParseRunning(text); ok {
			log.Info("test_started", "worker", workerID, "test", name)
		}
		if r, ok := hoot.ParseSuiteDone(text); ok {
			log.Info("suite_done", "worker", workerID, "suite", r.Suite, "passed", r.Passed, "failed", r.Failed, "ms", r.Ms)
		}
		if name, stack, ok := hoot.ParseFailure(text); ok {
			id := testIDByName(name, testIDs, cfg.meta)
			out <- event{
				kind:   kindFailure,
				id:     id,
				name:   name,
				stack:  stack,
				url:    hoot.DebugURL(cfg.serverURL, cfg.suitePath, id),
				worker: workerID,
			}
		}
		if result, ok := hoot.ParseDone(text); ok {
			done <- result
			return true
		}
		return false
	})()

	if err := page.WaitLoad(); err != nil {
		return fmt.Errorf("wait load: %w", err)
	}
	clicked, err := page.Eval(`() => {
		const btn = document.querySelector("hoot-container")?.shadowRoot?.querySelector("button:has(.fa-play):enabled");
		btn.click();
		return true;
	}`)
	if err != nil {
		return fmt.Errorf("click run button: %w", err)
	}
	if !clicked.Value.Bool() {
		return fmt.Errorf("run button not found")
	}
	log.Info("worker_run", "worker", workerID)

	select {
	case result := <-done:
		out <- event{kind: kindDone, passed: result.Passed, failed: result.Failed, worker: workerID}
	case <-ctx.Done():
		return fmt.Errorf("cancelled")
	}
	return nil
}

func argsToText(args []*proto.RuntimeRemoteObject) string {
	parts := make([]string, 0, len(args))
	for _, arg := range args {
		var s string
		if arg.Type == proto.RuntimeRemoteObjectTypeString {
			s = arg.Value.Str()
		} else if arg.Description != "" {
			s = arg.Description
		} else {
			continue
		}
		// Hoot uses console.log('%c[HOOT]%c msg', 'color:...', '') -- skip CSS args.
		if strings.HasPrefix(s, "color:") || strings.HasPrefix(s, "background:") || strings.HasPrefix(s, "font-") {
			continue
		}
		parts = append(parts, strings.ReplaceAll(s, "%c", ""))
	}
	return strings.Join(parts, " ")
}

func testIDByName(name string, testIDs []string, meta *hoot.Metadata) string {
	for _, id := range testIDs {
		if t, ok := meta.TestByID[id]; ok && t.Name == name {
			return id
		}
	}
	return ""
}
