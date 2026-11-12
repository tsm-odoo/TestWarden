// Top-level run: sets up the browser, auth and metadata, splits the tests in phases of
// parallel chunks, and loops over runs until the exit condition is met.

package runner

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-rod/rod"

	"test-warden/internal/auth"
	"test-warden/internal/browser"
	"test-warden/internal/hoot"
	"test-warden/internal/log"
)

type Config struct {
	ServerURL       string
	SuitePath       string
	SuiteNames      []string
	TestID          string
	Workers         int
	MinLoad         int
	CPUThrottling   int
	ChromePath      string
	FailFast        bool
	RunUntilFail    bool
	FlakyRuns       int
	Visible         bool
	PauseBeforeExit bool
	Debug           bool
	Console         bool
	WorkerTimeout   time.Duration
}

// Arbitrary high value to pass to `test.multi` when running single tests bail=1 (forced
// in execPage) makes Hoot stop as soon as the test fails.
const multiRunBatch = 200_000

// ExitInterrupted is the exit code of a run stopped by SIGINT or SIGTERM.
const ExitInterrupted = 130

// Run returns the process exit code: ExitInterrupted whenever it stopped because ctx was
// cancelled, whatever step it was at.
func Run(ctx context.Context, cfg Config) int {
	return exitCode(ctx, run(ctx, cfg))
}

func exitCode(ctx context.Context, code int) int {
	if ctx.Err() != nil {
		return ExitInterrupted
	}
	return code
}

func run(ctx context.Context, cfg Config) int {
	mobile := hoot.IsMobilePreset(cfg.SuitePath)
	done := log.Step("chrome_launch")
	wsURL, killChrome, err := browser.Launch(ctx, cfg.ChromePath, cfg.Visible, mobile)
	if err != nil {
		log.Error("chrome_launch", "err", err)
		return 2
	}
	defer killChrome()
	done()
	rodBrowser := rod.New().ControlURL(wsURL).Context(ctx).MustConnect()
	defer rodBrowser.Close()

	done = log.Step("db_fetch")
	dbName, err := auth.GetDatabase(cfg.ServerURL)
	if err != nil {
		log.Error("db_fetch", "err", err)
		return 2
	}
	done()

	done = log.StepLabel("auth", fmt.Sprintf("Authenticating to %s", log.Dyn(dbName)))
	cookie, err := auth.Authenticate(cfg.ServerURL, dbName, "admin", "admin")
	if err != nil {
		log.Error("auth", "err", err)
		return 2
	}
	done()

	// Kicked off right after auth: besides reading the test metadata, its navigation warms
	// the shared response cache, so workers don't all race each other to fetch the bundle.
	metaURL := hoot.MetaURL(cfg.ServerURL, cfg.SuitePath)
	warmCh := startCacheWarm(rodBrowser, metaURL, cfg.ServerURL, cookie)

	if cfg.FlakyRuns > 0 {
		if cfg.TestID == "" {
			log.Error("tests_resolve", "err", "--flaky-check requires a single test (use --test to select it)")
			return 2
		}
		if cfg.RunUntilFail || cfg.FailFast || cfg.Debug {
			log.Error("tests_resolve", "err", "--flaky-check cannot be combined with --run-until-fail, --fail-fast, or --debug")
			return 2
		}
	}

	meta, err := waitCacheWarm(ctx, warmCh)
	if ctx.Err() != nil {
		return ExitInterrupted
	}
	if err != nil {
		log.Error("meta_fetch", "err", err)
		return 2
	}
	testIDs, err := FilterIDs(meta, cfg.SuiteNames, cfg.TestID, mobile)
	if err != nil {
		log.Error("tests_resolve", "err", err)
		return 2
	}
	if len(testIDs) == 0 {
		log.Error("tests_resolve", "err", "no tests matched")
		return 3
	}
	if cfg.Debug && len(testIDs) != 1 {
		log.Error("tests_resolve", "err", "--debug requires exactly one test (use --test to select a single test, not --suite-names)")
		return 2
	}
	// Single tests are not bound to `MinLoad` as it would much likely result in a single
	// worker, which would be much slower.
	singleTestWorkers := max(cfg.Workers, 1)
	// Focus emulation is per page, but parallel pages still take the real focus from each
	// other, so a test that needs it only passes reliably when no other page runs alongside.
	if cfg.TestID != "" && singleTestWorkers > 1 && requiresFocus(meta, testIDs[0]) {
		log.Warn("tests_resolve", "hint", "test requires focus, running it on a single worker")
		singleTestWorkers = 1
	}
	// multiBail controls whether Hoot stops early on the first failed repetition: true for
	// --run-until-fail (hunting for a failure, so stop as soon as one turns up) and false for
	// --flaky-check (every repetition must run so the final ratio reflects all of them).
	multiCount := 0
	multiBail := false
	switch {
	case cfg.TestID != "" && cfg.RunUntilFail && !cfg.Debug:
		multiCount = multiRunBatch
		multiBail = true
	case cfg.FlakyRuns > 0:
		// Every worker runs its own multiCount repetitions of the same test, so split the
		// requested total across workers: --flaky-check N means N repetitions overall, not N per
		// worker (rounded up, so the actual total can be slightly above N).
		multiCount = (cfg.FlakyRuns + singleTestWorkers - 1) / singleTestWorkers
	}
	wcfg := workerConfig{
		serverURL:     cfg.ServerURL,
		suitePath:     cfg.SuitePath,
		cookie:        cookie,
		meta:          meta,
		failFast:      cfg.FailFast,
		browserWsURL:  wsURL,
		debugTest:     cfg.Debug || (cfg.Visible && cfg.TestID != ""),
		debugLogs:     cfg.Debug || cfg.Visible,
		cpuThrottling: cfg.CPUThrottling,
		multiCount:    multiCount,
		multiBail:     multiBail,
		mobile:        mobile,
		console:       cfg.Console,
		workerTimeout: cfg.WorkerTimeout,
	}
	if cfg.TestID != "" {
		testName := cfg.TestID
		if test, ok := meta.TestByID[testIDs[0]]; ok {
			testName = test.Name
		}
		log.LogLine("info", fmt.Sprintf("ℹ Running test: %s. (from %s)", log.Dyn(testName), log.Dyn(cfg.SuitePath)))
	} else if len(cfg.SuiteNames) > 0 {
		log.LogLine("info", fmt.Sprintf("ℹ Running suites: %s. (from %s)", log.Dyn(strings.Join(cfg.SuiteNames, ", ")), log.Dyn(cfg.SuitePath)))
	} else {
		log.LogLine("info", fmt.Sprintf("ℹ Running all tests. (from %s)", log.Dyn(cfg.SuitePath)))
	}
	// Each phase runs its chunks in parallel, one per page, and phases run one after the
	// other within a run. Usually a single phase, plus a trailing single-worker one for tests
	// that require focus whenever the rest is split across several workers.
	var phases [][][]string
	if cfg.TestID != "" {
		chunks := make([][]string, singleTestWorkers)
		for i := range chunks {
			chunks[i] = testIDs
		}
		phases = [][][]string{chunks}
	} else if chunks := SplitTests(testIDs, cfg.Workers, cfg.MinLoad); len(chunks) > 1 {
		focusIDs, otherIDs := partitionFocusRequired(meta, testIDs)
		if len(focusIDs) > 0 {
			log.LogLine("info", fmt.Sprintf("ℹ %s tests require focus, they run on a single worker after the others",
				log.Dyn(fmt.Sprintf("%d", len(focusIDs)))))
			chunks = SplitTests(otherIDs, cfg.Workers, cfg.MinLoad)
		}
		if len(chunks) > 0 {
			phases = append(phases, chunks)
		}
		if len(focusIDs) > 0 {
			phases = append(phases, [][]string{focusIDs})
		}
	} else {
		phases = [][][]string{chunks}
	}
	workerCount := 0
	totalRuns := 0
	for _, chunks := range phases {
		workerCount = max(workerCount, len(chunks))
		for _, chunk := range chunks {
			totalRuns += len(chunk)
		}
	}
	log.LogLine("info", fmt.Sprintf("ℹ %s tests across %s workers",
		log.Dyn(fmt.Sprintf("%d", len(testIDs))), log.Dyn(fmt.Sprintf("%d", workerCount))))

	// In single test mode every worker runs the same test each iteration, so one
	// iteration accounts for workerCount runs of that test, not just one. When multi is
	// active, each worker also repeats it multiCount times before the next iteration
	// reloads, so that factors into the increment too.
	runIncrement := 1
	if cfg.TestID != "" {
		runIncrement = workerCount
		if wcfg.multiCount > 0 {
			runIncrement *= wcfg.multiCount
		}
	}

	// Create browser pages once (workers_launch). Pages are reused across runs and phases.
	done = log.Step("workers_launch")
	pages := make([]*rod.Page, workerCount)
	setupOK := make([]bool, workerCount)
	navReady := make(chan struct{}, workerCount)

	for i := range workerCount {
		go func(id int) {
			b, err := rodBrowser.Incognito()
			if err != nil {
				log.Error("worker_error", "worker", id, "err", err.Error())
				navReady <- struct{}{}
				return
			}
			page, err := setupPage(ctx, b, id, wcfg)
			if err != nil {
				log.Error("worker_error", "worker", id, "err", err.Error())
				navReady <- struct{}{}
				return
			}
			pages[id] = page
			setupOK[id] = true
			navReady <- struct{}{}
		}(i)
	}
	for range workerCount {
		select {
		case <-navReady:
		case <-ctx.Done():
			done()
			return ExitInterrupted
		}
	}
	done()

	defer func() {
		for _, browserPage := range pages {
			if browserPage != nil {
				browserPage.Close()
			}
		}
	}()

	for i := range workerCount {
		if !setupOK[i] {
			return 2
		}
	}

	// With bail active, every worker already stops on its first failure. A worker running
	// a different page has no way to know about it otherwise: stopAll asks every page's
	// runner to stop as soon as any one of them reports a failure.
	bail := cfg.FailFast || wcfg.multiBail
	// Run loop: navigate (or reload) each page and collect results.
	for runNum := 1; ; runNum += runIncrement {
		log.RunStart(runNum, totalRuns, wcfg.multiCount > 0)

		onFailure := func() {}
		if bail {
			var stopOnce sync.Once
			onFailure = func() {
				stopOnce.Do(func() {
					for _, p := range pages {
						if p != nil {
							go stopHootRunner(p)
						}
					}
				})
			}
		}
		passed, failed := 0, 0
		for phaseIndex, chunks := range phases {
			if phaseIndex > 0 {
				if bail && failed > 0 {
					break
				}
				// Every page took the focus in turn during setup; hand it back to the one
				// about to run alone.
				_, _ = pages[0].Activate()
			}
			phasePassed, phaseFailed := runPhase(ctx, chunks, pages, wcfg, onFailure)
			passed += phasePassed
			failed += phaseFailed
		}
		if ctx.Err() != nil {
			return ExitInterrupted
		}
		log.RunDone(runNum, passed, failed, passed+failed, cfg.RunUntilFail && failed == 0)
		if cfg.FlakyRuns > 0 {
			log.FlakyResult(passed, failed, passed+failed)
		}
		if failed > 0 {
			if cfg.PauseBeforeExit {
				fmt.Fprintf(os.Stderr, "\nBrowser paused after failure. Open devtools URLs from the log above.\nPress any key to quit.\n")
				log.RunWaitPrompt()
				waitForQuit(ctx)
			}
			return 1
		}
		if !cfg.RunUntilFail {
			return 0
		}
	}
}

// Runs each chunk on the page with the same index, all in parallel, and returns the
// combined tally once every one of them is done.
func runPhase(ctx context.Context, chunks [][]string, pages []*rod.Page, wcfg workerConfig, onFailure func()) (passed, failed int) {
	out := make(chan event, 256)
	var runWg sync.WaitGroup
	for i, chunk := range chunks {
		runWg.Add(1)
		go func(id int, ids []string, page *rod.Page) {
			defer runWg.Done()
			err := execPage(ctx, page, id, ids, wcfg, out)
			if err != nil && ctx.Err() == nil {
				out <- event{kind: kindError, worker: id, stack: err.Error()}
			}
		}(i, chunk, pages[i])
	}
	go func() {
		runWg.Wait()
		close(out)
	}()
	return drain(out, onFailure)
}

// Blocks until the user presses a key (any input on stdin) or the context is cancelled
// (e.g. Ctrl+C).
func waitForQuit(ctx context.Context) {
	done := make(chan struct{})
	go func() {
		bufio.NewScanner(os.Stdin).Scan()
		close(done)
	}()
	select {
	case <-ctx.Done():
	case <-done:
	}
}

// Result of the background hoot.Fetch kicked off by startCacheWarm.
type metaFetchResult struct {
	meta *hoot.Metadata
	err  error
}

// Starts the suite's one and only page fetch as soon as we have a cookie. It reads the
// test metadata and, through its navigation, warms the shared response cache in the
// background while the remaining setup runs.
func startCacheWarm(rodBrowser *rod.Browser, metaURL, serverURL string, cookie *auth.Cookie) <-chan metaFetchResult {
	resultCh := make(chan metaFetchResult, 1)
	go func() {
		meta, err := hoot.Fetch(rodBrowser, metaURL, serverURL, cookie)
		resultCh <- metaFetchResult{meta: meta, err: err}
	}()
	return resultCh
}

// Waits for the metadata fetch started by startCacheWarm, under a labeled step.
func waitCacheWarm(ctx context.Context, warmCh <-chan metaFetchResult) (*hoot.Metadata, error) {
	done := log.Step("meta_fetch")
	defer done()
	select {
	case result := <-warmCh:
		return result.meta, result.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func drain(out <-chan event, onFailure func()) (passed, failed int) {
	for workerEvent := range out {
		switch workerEvent.kind {
		case kindFailure:
			log.TestFail(workerEvent.worker, workerEvent.id, workerEvent.name, workerEvent.url, workerEvent.stack)
			onFailure()

		case kindDone:
			log.Info("worker_done", "worker", workerEvent.worker, "passed", workerEvent.passed, "failed", workerEvent.failed)
			passed += workerEvent.passed
			failed += workerEvent.failed
			if workerEvent.failed > 0 {
				onFailure()
			}

		case kindPartial:
			passed += workerEvent.passed
			failed += workerEvent.failed
			if len(workerEvent.notRun) > 0 {
				log.TestsNotRun(workerEvent.worker, workerEvent.notRun)
			}

		case kindError:
			log.Error("worker_error", "worker", workerEvent.worker, "err", workerEvent.stack)
			failed++
		}
	}
	return passed, failed
}
