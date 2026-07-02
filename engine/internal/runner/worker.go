package runner

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"

	"test-warden/internal/auth"
	wardenbrowser "test-warden/internal/browser"
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
	id     string
	name   string
	stack  string // console trace (failure) or error message (error)
	url    string
	passed int
	failed int
	worker int
}

type workerConfig struct {
	serverURL     string
	suitePath     string
	cookie        *auth.Cookie
	meta          *hoot.Metadata
	failFast      bool
	browserWsURL  string
	debugTest     bool // add &debugTest=true to worker URL (single test, visible mode)
	cpuThrottling int  // CPU throttling factor (0-100), applied via CDP
}

// Creates and configures a new browser page for a worker. Caller must close the page when done.
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
	if parsedURL, err := url.Parse(cfg.browserWsURL); err == nil {
		devtoolsURL = fmt.Sprintf("http://%s/devtools/inspector.html?ws=%s/devtools/page/%s",
			parsedURL.Host, parsedURL.Host, page.TargetID)
	}

	if err := wardenbrowser.SetupPageCache(page, cfg.serverURL); err != nil {
		page.Close()
		return nil, fmt.Errorf("setup cache: %w", err)
	}

	if _, err := page.Activate(); err != nil {
		page.Close()
		return nil, fmt.Errorf("activate page: %w", err)
	}
	if err := (proto.EmulationSetFocusEmulationEnabled{Enabled: true}.Call(page)); err != nil {
		page.Close()
		return nil, fmt.Errorf("enable focus emulation: %w", err)
	}

	if cfg.cpuThrottling > 0 {
		rate := float64(cfg.cpuThrottling + 1)
		if err := (proto.EmulationSetCPUThrottlingRate{Rate: rate}.Call(page)); err != nil {
			page.Close()
			return nil, fmt.Errorf("set cpu throttling: %w", err)
		}
	}

	log.Info("worker_start", "worker", workerID, "devtools", devtoolsURL)
	return page, nil
}

// Navigates page to the worker URL and runs one full test cycle. All events (failures,
// done) are sent on out.
func execPage(
	ctx context.Context,
	page *rod.Page,
	workerID int,
	testIDs []string,
	cfg workerConfig,
	out chan<- event,
) error {
	// Enable Runtime and register the exception/console listeners before navigating, so
	// an error thrown or logged early can't be missed and hang execPage forever.
	if err := (proto.RuntimeEnable{}.Call(page)); err != nil {
		return fmt.Errorf("enable runtime: %w", err)
	}
	done := make(chan hoot.DoneResult, 1)
	pageErr := make(chan string, 1)
	reportPageErr := func(msg string) {
		select {
		case pageErr <- msg:
		default:
		}
	}
	// EachEvent returns a wait function that must be called (in a goroutine) to start reading events.
	go page.EachEvent(
		func(consoleEvent *proto.RuntimeConsoleAPICalled) bool {
			text := argsToText(consoleEvent.Args)
			matched := false
			if name, ok := hoot.ParseRunning(text); ok {
				log.TestStarted(name)
				matched = true
			}
			if suiteDone, ok := hoot.ParseSuiteDone(text); ok {
				log.Info("suite_done", "worker", workerID, "suite", suiteDone.Suite, "passed", suiteDone.Passed, "failed", suiteDone.Failed, "ms", suiteDone.Ms)
				matched = true
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
				matched = true
			}
			if result, ok := hoot.ParseDone(text); ok {
				done <- result
				return true
			}
			// A console.error that Hoot's own parsers don't recognize means its runner
			// caught (and logged) an error it can't recover from on its own -- treat it
			// the same as an uncaught exception rather than waiting forever for a
			// "done" that will never come.
			if !matched && consoleEvent.Type == proto.RuntimeConsoleAPICalledTypeError {
				reportPageErr(text)
			}
			return false
		},
		func(runtimeException *proto.RuntimeExceptionThrown) bool {
			msg := runtimeException.ExceptionDetails.Text
			if runtimeException.ExceptionDetails.Exception != nil && runtimeException.ExceptionDetails.Exception.Description != "" {
				msg = runtimeException.ExceptionDetails.Exception.Description
			}
			reportPageErr(msg)
			return false
		},
	)()
	workerURL := hoot.WorkerURL(cfg.serverURL, cfg.suitePath, testIDs, cfg.failFast, cfg.debugTest)
	if err := page.Navigate(workerURL); err != nil {
		return fmt.Errorf("navigate: %w", err)
	}
	if cfg.debugTest {
		// In debug mode Hoot doesn't report the outcome in the console.Poll for it instead.
		go pollDebugToolbar(ctx, page, done)
	}
	if err := clickPlayButton(ctx, page); err != nil {
		return err
	}
	log.Info("worker_run", "worker", workerID)
	select {
	case result := <-done:
		out <- event{kind: kindDone, passed: result.Passed, failed: result.Failed, worker: workerID}
	case msg := <-pageErr:
		return fmt.Errorf("uncaught page error: %s", msg)
	case <-ctx.Done():
		return fmt.Errorf("cancelled")
	}
	return nil
}

// Polls for Hoot's run button and clicks it as soon as it's present and enabled. Hoot
// renders its own UI well before the page's "load" event.
func clickPlayButton(ctx context.Context, page *rod.Page) error {
	deadline := time.Now().Add(60 * time.Second)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("cancelled")
		case <-ticker.C:
			clicked, err := page.Eval(`() => {
				const btn = document.querySelector("hoot-container")?.shadowRoot?.querySelector("button:has(.fa-play):enabled");
				if (!btn) return false;
				btn.click();
				return true;
			}`)
			if err != nil {
				return fmt.Errorf("click run button: %w", err)
			}
			if clicked.Value.Bool() {
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("run button not found")
			}
		}
	}
}

// Watches for Hoot's debug toolbar (shown after a test finishes, and the only information
// available in --debug mode) and sends its outcome on done once the status is known.
func pollDebugToolbar(ctx context.Context, page *rod.Page, done chan<- hoot.DoneResult) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			result, err := page.Eval(`() => {
				const bar = document.querySelector("hoot-container")?.shadowRoot?.querySelector(".HootDebugToolBar");
				const text = bar?.querySelector("button.flex-1")?.textContent ?? "";
				if (/status:\s*passed/i.test(text)) return "passed";
				if (/status:\s*failed/i.test(text)) return "failed";
				return "";
			}`)
			if err != nil {
				continue
			}
			switch result.Value.Str() {
			case "passed":
				done <- hoot.DoneResult{Passed: 1}
				return
			case "failed":
				done <- hoot.DoneResult{Failed: 1}
				return
			}
		}
	}
}

func argsToText(args []*proto.RuntimeRemoteObject) string {
	parts := make([]string, 0, len(args))
	for _, arg := range args {
		var str string
		if arg.Type == proto.RuntimeRemoteObjectTypeString {
			str = arg.Value.Str()
		} else if arg.Description != "" {
			str = arg.Description
		} else {
			continue
		}
		// Hoot uses console.log('%c[HOOT]%c msg', 'color:...', '') -- skip CSS args.
		if strings.HasPrefix(str, "color:") || strings.HasPrefix(str, "background:") || strings.HasPrefix(str, "font-") {
			continue
		}
		parts = append(parts, strings.ReplaceAll(str, "%c", ""))
	}
	return strings.Join(parts, " ")
}

func testIDByName(name string, testIDs []string, meta *hoot.Metadata) string {
	for _, testID := range testIDs {
		if test, ok := meta.TestByID[testID]; ok && test.Name == name {
			return testID
		}
	}
	return ""
}
