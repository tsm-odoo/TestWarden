package runner

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
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
	// What a worker got through before it failed, sent right ahead of its kindError.
	kindPartial eventKind = "partial"
)

type event struct {
	kind    eventKind
	id      string
	name    string
	stack   string // console trace (failure) or error message (error)
	url     string
	passed  int
	failed  int
	worker  int
	warning bool     // failure synthesized from a console.warn, so absent from Hoot's own tally
	notRun  []string // kindPartial: ids of the worker's tests that never started
}

// What one worker has gone through so far, to still account for it when it dies before
// Hoot's final summary. Filled by the console listener, read when execPage fails.
type progress struct {
	mu      sync.Mutex
	started []string        // tests in the order they started
	running bool            // the last started test may still be running (no suite end since)
	failed  map[string]bool // tests with a failure reported by Hoot
}

func (p *progress) start(name string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.started = append(p.started, name)
	p.running = true
}

func (p *progress) suiteEnded() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.running = false
}

func (p *progress) fail(name string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.failed[name] = true
}

// Tallies the tests that completed before the worker died: all the started ones but the last,
// which is the one the worker died in unless its suite had already ended. Also returns the ids
// of the tests that never started.
func (p *progress) partial(workerID int, testIDs []string, meta *hoot.Metadata) event {
	p.mu.Lock()
	defer p.mu.Unlock()
	completed := p.started
	if p.running && len(completed) > 0 {
		completed = completed[:len(completed)-1]
	}
	result := event{kind: kindPartial, worker: workerID}
	seen := make(map[string]bool, len(p.started))
	for _, name := range completed {
		if seen[name] {
			continue
		}
		seen[name] = true
		if p.failed[name] {
			result.failed++
		} else {
			result.passed++
		}
	}
	startedIDs := make(map[string]bool, len(p.started))
	for _, name := range p.started {
		startedIDs[testIDByName(name, testIDs, meta)] = true
	}
	for _, id := range testIDs {
		if !startedIDs[id] {
			result.notRun = append(result.notRun, id)
		}
	}
	return result
}

type workerConfig struct {
	serverURL     string
	suitePath     string
	cookie        *auth.Cookie
	meta          *hoot.Metadata
	failFast      bool
	browserWsURL  string
	debugTest     bool          // add &debugTest=true to worker URL (single test, visible mode)
	debugLogs     bool          // run Hoot at its debug log level (visible or debug mode)
	cpuThrottling int           // CPU throttling factor (0-100), applied via CDP
	multiCount    int           // when > 0, repeat testIDs this many times in-page via Hoot's multi config instead of reloading
	multiBail     bool          // when multiCount > 0, whether Hoot should stop at the first failed repetition instead of running them all
	mobile        bool          // Hoot's mobile preset: 375x667 viewport, like Odoo's MobileWebSuite
	console       bool          // forward console lines Hoot doesn't emit itself (log.Console)
	workerTimeout time.Duration // fail the worker after this long without test progress; 0 disables
}

// Creates and configures a new browser page for a worker. Caller must close the page when done.
func setupPage(
	ctx context.Context,
	browser *rod.Browser,
	workerID int,
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
	if cfg.mobile {
		viewport := proto.EmulationSetDeviceMetricsOverride{Width: 375, Height: 667, DeviceScaleFactor: 1}
		if err := viewport.Call(page); err != nil {
			page.Close()
			return nil, fmt.Errorf("set mobile viewport: %w", err)
		}
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
) (execErr error) {
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

	// Repeated tests (multi) share their names, so only a plain run can be tallied by name.
	tally := &progress{failed: map[string]bool{}}
	defer func() {
		if execErr != nil && cfg.multiCount == 0 && ctx.Err() == nil {
			out <- tally.partial(workerID, testIDs, cfg.meta)
		}
	}()

	// Last time the page reported test progress (a test starting or a suite ending), and the
	// test running at that point, read by the stall watchdog below.
	var lastProgress atomic.Int64
	var lastTest atomic.Value
	lastTest.Store("")
	markProgress := func() { lastProgress.Store(time.Now().UnixNano()) }

	// The listener is bound to this call: once execPage returns, it must not keep sending on
	// out, which the caller closes after every worker has returned.
	listenCtx, stopListening := context.WithCancel(ctx)
	listenerDone := make(chan struct{})
	defer func() {
		stopListening()
		<-listenerDone
	}()

	// Track which test is currently executing so console.warn events can be attributed to it.
	var currentTestName string
	// Nesting of console groups at the current point of the page's console (see --console).
	groupDepth := 0
	wait := page.Context(listenCtx).EachEvent(
		func(consoleEvent *proto.RuntimeConsoleAPICalled) bool {
			text := hoot.ArgsToText(consoleEvent.Args)
			matched := false
			if name, ok := hoot.ParseRunning(text); ok {
				currentTestName = name
				lastTest.Store(name)
				tally.start(name)
				markProgress()
				log.TestStarted(name)
				matched = true
			}
			if suiteDone, ok := hoot.ParseSuiteDone(text); ok {
				currentTestName = ""
				tally.suiteEnded()
				markProgress()
				log.Info("suite_done", "worker", workerID, "suite", suiteDone.Suite, "passed", suiteDone.Passed, "failed", suiteDone.Failed, "ms", suiteDone.Ms)
				matched = true
			}
			if name, stack, ok := hoot.ParseFailure(text); ok {
				matched = true
				if !hoot.IsAbortedFailure(stack) {
					tally.fail(name)
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
			}
			// Treat console.warn during an active test as a test failure.
			if !matched && consoleEvent.Type == proto.RuntimeConsoleAPICalledTypeWarning && currentTestName != "" {
				id := testIDByName(currentTestName, testIDs, cfg.meta)
				out <- event{
					kind:    kindFailure,
					id:      id,
					name:    currentTestName,
					stack:   fmt.Sprintf("Warning during test: %s", text),
					url:     hoot.DebugURL(cfg.serverURL, cfg.suitePath, id),
					worker:  workerID,
					warning: true,
				}
				matched = true
			}
			if result, ok := hoot.ParseDone(text); ok {
				currentTestName = ""
				done <- result
				return true
			}
			if cfg.console && !matched {
				forwardConsole(consoleEvent, hoot.ArgsToPreviewText(consoleEvent.Args), &groupDepth, workerID, currentTestName)
			}
			// A console.error that Hoot's parser don't recognize means its runner caught
			// (and logged) an error it can't recover from on its own. Treat it the same
			// as an uncaught exception rather than waiting forever for a "done" that will
			// never come.
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
	)
	go func() {
		wait()
		close(listenerDone)
	}()
	// Bail stops Hoot at the first failed repetition. Forced on for --run-until-fail's multi
	// batch (no point grinding through 200k more reps once one has failed) but left off for
	// --flaky-check, which needs every repetition to run so the final ratio covers all of them.
	bail := cfg.failFast || cfg.multiBail
	workerURL := hoot.WorkerURL(cfg.serverURL, cfg.suitePath, testIDs, bail, cfg.debugTest, cfg.debugLogs)
	if err := page.Navigate(workerURL); err != nil {
		return fmt.Errorf("navigate: %w", err)
	}
	if cfg.multiCount > 0 {
		if err := configureMulti(ctx, page, testIDs, cfg.multiCount, pageErr); err != nil {
			return fmt.Errorf("configure multi: %w", err)
		}
	}
	if cfg.debugTest {
		// In debug mode Hoot doesn't report the outcome in the console.Poll for it instead.
		go pollDebugToolbar(ctx, page, done)
	}
	if err := clickPlayButton(ctx, page); err != nil {
		return err
	}
	log.Info("worker_run", "worker", workerID)

	// Watchdog for a page that stops making progress without throwing (e.g. a frozen
	// renderer): Hoot's own per-test timeout can't fire then, so nothing else would end the
	// run. Not armed in debug mode, where the test is paused on purpose.
	var stallCheck <-chan time.Time
	if cfg.workerTimeout > 0 && !cfg.debugTest {
		markProgress()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		stallCheck = ticker.C
	}
	for {
		select {
		case <-stallCheck:
			idle := time.Since(time.Unix(0, lastProgress.Load()))
			if idle < cfg.workerTimeout {
				continue
			}
			// Closed at the browser level: Page.close goes through the renderer, which may be
			// the very thing that is stuck.
			_, _ = proto.TargetCloseTarget{TargetID: page.TargetID}.Call(page.Browser())
			at := "before the first test started"
			if name := lastTest.Load().(string); name != "" {
				at = fmt.Sprintf("last test started: %q", name)
			}
			return fmt.Errorf("worker stalled: no test progress for %s (%s), page closed",
				idle.Round(time.Second), at)
		case result := <-done:
			out <- event{kind: kindDone, passed: result.Passed, failed: result.Failed, worker: workerID}
			return nil
		case msg := <-pageErr:
			// In --flaky-check mode (multi with no bail) a page error most often means a
			// single repetition crashed, not the whole run: Hoot recovers and keeps going
			// through the remaining repetitions on its own, so abandoning the rest of this
			// worker's batch here would cut the flaky ratio short. Log it and keep waiting
			// for the batch's real "done" instead.
			if cfg.multiCount > 0 && !cfg.multiBail {
				log.Error("worker_page_error", "worker", workerID, "err", msg)
				continue
			}
			return fmt.Errorf("uncaught page error: %s", msg)
		case <-ctx.Done():
			return fmt.Errorf("cancelled")
		}
	}
}

// Forwards a console line Hoot didn't emit itself, as a test would with a plain console.log.
// Workers run Hoot at its debug log level, which floods the console with its own
// instrumentation (request traces, dispatched events, grouped mock server logs): anything
// inside a console group, not logged through log/info/debug/warn, or styled with Hoot's
// "%c[PREFIX]%c" header is part of it. Errors are left out as they already end the run as
// page errors.
func forwardConsole(consoleEvent *proto.RuntimeConsoleAPICalled, text string, groupDepth *int, workerID int, testName string) {
	kind := consoleEvent.Type
	switch kind {
	case proto.RuntimeConsoleAPICalledTypeStartGroup, proto.RuntimeConsoleAPICalledTypeStartGroupCollapsed:
		*groupDepth++
	case proto.RuntimeConsoleAPICalledTypeEndGroup:
		*groupDepth = max(*groupDepth-1, 0)
	case proto.RuntimeConsoleAPICalledTypeLog, proto.RuntimeConsoleAPICalledTypeInfo,
		proto.RuntimeConsoleAPICalledTypeDebug, proto.RuntimeConsoleAPICalledTypeWarning:
		args := consoleEvent.Args
		hootStyled := len(args) > 0 && args[0].Type == proto.RuntimeRemoteObjectTypeString &&
			strings.HasPrefix(args[0].Value.Str(), "%c[")
		if *groupDepth == 0 && !hootStyled {
			log.Console(workerID, testName, string(kind), text)
		}
	}
}

// Polls until Hoot has registered testIDs, then sets their `multi` config so the runner
// repeats each of them count times within this page load instead of once. `hoot.__debug__`
// is the live Runner instance, exposed as a function on some Hoot versions and a getter on
// others; its `tests` map holds the actual Test job objects, so setting `.config.multi` here
// is equivalent to a `test.multi(count)` call made before the test was registered.
func configureMulti(ctx context.Context, page *rod.Page, testIDs []string, count int, pageErr <-chan string) error {
	deadline := time.Now().Add(60 * time.Second)
	for {
		res, err := page.Eval(`(ids, count) => {
			const hoot = window.odoo?.loader?.modules?.get("@web/../lib/hoot/hoot");
			if (!hoot) return false;
			let runner;
			try {
				runner = hoot.__debug__();
			} catch (e) {
				runner = hoot.__debug__;
			}
			if (!runner) return false;
			for (const id of ids) {
				if (!runner.tests.get(id)) return false;
			}
			for (const id of ids) {
				runner.tests.get(id).config.multi = count;
			}
			return true;
		}`, testIDs, count)
		if err == nil && res.Value.Bool() {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timeout waiting for hoot to register tests for multi config")
		}
		// Checked here (rather than failing fast the instant pageErr fires) so a page error
		// that arrives just as the tests finish registering doesn't pre-empt success -- one
		// more Eval above always gets a chance first.
		select {
		case <-ctx.Done():
			return fmt.Errorf("cancelled")
		case msg := <-pageErr:
			return fmt.Errorf("uncaught page error: %s", msg)
		case <-time.After(25 * time.Millisecond):
		}
	}
}

// Best-effort request for Hoot to stop this page's run right away, the same way bail would.
// Used to abort sibling workers as soon as any worker's test fails: bail only stops the
// runner on the page where the failure actually happened, so without this the others would
// keep grinding through their own remaining multi repetitions unaware anything failed.
func stopHootRunner(page *rod.Page) {
	_, _ = page.Eval(`() => {
		const hoot = window.odoo?.loader?.modules?.get("@web/../lib/hoot/hoot");
		if (!hoot) return;
		let runner;
		try {
			runner = hoot.__debug__();
		} catch (e) {
			runner = hoot.__debug__;
		}
		runner?.stop();
	}`)
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
				const btn = document.querySelector("hoot-container")?.shadowRoot?.querySelector("button[title='Run']:enabled");
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

func testIDByName(name string, testIDs []string, meta *hoot.Metadata) string {
	for _, testID := range testIDs {
		if test, ok := meta.TestByID[testID]; ok && test.Name == name {
			return testID
		}
	}
	return ""
}
