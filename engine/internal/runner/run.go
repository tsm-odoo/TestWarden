package runner

import (
	"bufio"
	"context"
	"fmt"
	"hash/fnv"
	"net/url"
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
	ServerURL         string
	SuitePath         string
	SuiteNames        []string
	TestID            string
	Workers           int
	MinLoad           int
	CPUThrottling     int
	ChromePath        string
	WorktreeContainer string
	FailFast          bool
	RunUntilFail      bool
	Visible           bool
	PauseBeforeExit   bool
	Debug             bool
}

// Arbitrary high value to pass to `test.multi` when running single tests bail=1 (forced
// in execPage) makes Hoot stop as soon as the test fails.
const multiRunBatch = 200_000

// Top-level entry point. Returns an exit code (0, 1, or 2).
func Run(ctx context.Context, cfg Config) int {
	done := log.Step("chrome_launch")
	wsURL, killChrome, err := browser.Launch(ctx, cfg.ChromePath, cfg.Visible)
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

	meta, err := loadMeta(rodBrowser, cfg, dbName, cookie)
	if err != nil {
		log.Error("meta_fetch", "err", err)
		return 2
	}
	multiCount := 0
	if cfg.TestID != "" && cfg.RunUntilFail && !cfg.Debug {
		multiCount = multiRunBatch
	}
	wcfg := workerConfig{
		serverURL:     cfg.ServerURL,
		suitePath:     cfg.SuitePath,
		cookie:        cookie,
		meta:          meta,
		failFast:      cfg.FailFast,
		browserWsURL:  wsURL,
		debugTest:     cfg.Debug || (cfg.Visible && cfg.TestID != ""),
		cpuThrottling: cfg.CPUThrottling,
		multiCount:    multiCount,
	}
	testIDs, err := FilterIDs(meta, cfg.SuiteNames, cfg.TestID)
	if err != nil {
		log.Error("tests_resolve", "err", err)
		return 2
	}
	if len(testIDs) == 0 {
		log.Warn("run_skip")
		return 0
	}
	if cfg.Debug && len(testIDs) != 1 {
		log.Error("tests_resolve", "err", "--debug requires exactly one test (use --test to select a single test, not --suite-names)")
		return 2
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
	var chunks [][]string
	if cfg.TestID != "" {
		// Single tests is not bound to `MinLoad` as it would much likely result in a
		// single worker, which would be much slower.
		workers := max(cfg.Workers, 1)
		chunks = make([][]string, workers)
		for i := range chunks {
			chunks[i] = testIDs
		}
	} else {
		chunks = SplitTests(testIDs, cfg.Workers, cfg.MinLoad)
	}
	totalRuns := 0
	for _, chunk := range chunks {
		totalRuns += len(chunk)
	}
	log.LogLine("info", fmt.Sprintf("ℹ %s tests across %s workers",
		log.Dyn(fmt.Sprintf("%d", len(testIDs))), log.Dyn(fmt.Sprintf("%d", len(chunks)))))

	// In single test mode every worker runs the same test each iteration, so one
	// iteration accounts for len(chunks) runs of that test, not just one. When multi is
	// active, each worker also repeats it multiCount times before the next iteration
	// reloads, so that factors into the increment too.
	runIncrement := 1
	if cfg.TestID != "" {
		runIncrement = len(chunks)
		if wcfg.multiCount > 0 {
			runIncrement *= wcfg.multiCount
		}
	}

	// Create browser pages once (workers_launch). Pages are reused across runs.
	done = log.Step("workers_launch")
	pages := make([]*rod.Page, len(chunks))
	setupOK := make([]bool, len(chunks))
	navReady := make(chan struct{}, len(chunks))

	var setupWg sync.WaitGroup
	for i, chunk := range chunks {
		setupWg.Add(1)
		go func(id int, ids []string) {
			defer setupWg.Done()
			b := rodBrowser
			if id > 0 {
				var err error
				b, err = rodBrowser.Incognito()
				if err != nil {
					log.Error("worker_error", "worker", id, "err", err.Error())
					navReady <- struct{}{}
					return
				}
			}
			page, err := setupPage(ctx, b, id, ids, wcfg)
			if err != nil {
				log.Error("worker_error", "worker", id, "err", err.Error())
				navReady <- struct{}{}
				return
			}
			pages[id] = page
			setupOK[id] = true
			navReady <- struct{}{}
		}(i, chunk)
	}
	for range chunks {
		select {
		case <-navReady:
		case <-ctx.Done():
			done()
			return 0
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

	for i := range chunks {
		if !setupOK[i] {
			return 2
		}
	}

	// With bail active, every worker already stops itself on its own first failure; a
	// worker running a different page (e.g. a sibling repeating the same test via multi)
	// has no way to know about it otherwise, so it would keep going until it separately
	// fails or its own batch runs out. stopAll asks every page's runner to stop as soon as
	// any one of them reports a failure.
	bail := cfg.FailFast || wcfg.multiCount > 0

	// Run loop: navigate (or reload) each page and collect results.
	for runNum := 1; ; runNum += runIncrement {
		log.RunStart(runNum, totalRuns, wcfg.multiCount > 0)

		out := make(chan event, 256)
		var runWg sync.WaitGroup

		for i, chunk := range chunks {
			runWg.Add(1)
			go func(id int, ids []string, page *rod.Page) {
				defer runWg.Done()
				if err := execPage(ctx, page, id, ids, wcfg, out); err != nil {
					out <- event{kind: kindError, worker: id, stack: err.Error()}
				}
			}(i, chunk, pages[i])
		}

		go func() {
			runWg.Wait()
			close(out)
		}()

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
		code := drain(out, runNum, cfg.RunUntilFail, onFailure)
		if code != 0 {
			if cfg.PauseBeforeExit {
				fmt.Fprintf(os.Stderr, "\nBrowser paused after failure. Open devtools URLs from the log above.\nPress any key to quit.\n")
				log.RunWaitPrompt()
				waitForQuit(ctx)
			}
			return code
		}
		if !cfg.RunUntilFail {
			return 0
		}
	}
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

func loadMeta(rodBrowser *rod.Browser, cfg Config, dbName string, cookie *auth.Cookie) (*hoot.Metadata, error) {
	metaURL := hoot.MetaURL(cfg.ServerURL, cfg.SuitePath)

	if cfg.WorktreeContainer == "" {
		log.Warn("no_repositories_configured", "hint",
			`add "worktreeContainer" to engine/settings.json to cache test metadata between runs and speed up startup, e.g.: `+
				`{"worktreeContainer": "/path/to/worktrees"}`)
		return fetchMetaUncached(rodBrowser, metaURL, cookie)
	}

	if !isLocalServer(cfg.ServerURL) {
		return fetchMetaUncached(rodBrowser, metaURL, cookie)
	}

	cacheDir := ".cache"
	worktreeDir, err := hoot.FindWorktreeDir(cfg.WorktreeContainer, dbName, cacheDir)
	if err != nil {
		return nil, fmt.Errorf("find worktree dir: %w", err)
	}
	if worktreeDir == "" {
		log.LogLine("info", fmt.Sprintf("ℹ Could not find repository for %s", log.Dyn(dbName)))
		return nil, fmt.Errorf("no directory named %q found under worktreeContainer %q", dbName, cfg.WorktreeContainer)
	}
	log.LogLine("info", fmt.Sprintf("ℹ Found repository at: %s", log.Dyn(worktreeDir)))
	addonsPath := []string{worktreeDir}

	done := log.Step("meta_fingerprint")
	var testDirs []hoot.TestDir
	var testDirsErr error
	var installedModules []string
	var modulesErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		testDirs, testDirsErr = hoot.FindTestDirs(addonsPath)
	}()
	go func() {
		defer wg.Done()
		installedModules, modulesErr = auth.ListInstalledModules(cfg.ServerURL, cookie)
	}()
	wg.Wait()
	if testDirsErr != nil {
		return nil, fmt.Errorf("find test dirs: %w", testDirsErr)
	}
	if modulesErr != nil {
		log.Warn("meta_modules_fingerprint_fail", "err", modulesErr)
		installedModules = nil // scan every addon rather than silently under-scanning
	}
	fingerprint, fingerprintErr := hoot.FingerprintTestDirs(testDirs, installedModules)
	if fingerprintErr != nil {
		return nil, fmt.Errorf("fingerprint addons: %w", fingerprintErr)
	}
	if modulesErr == nil {
		h := fnv.New32a()
		for _, name := range installedModules {
			h.Write([]byte(name))
		}
		fingerprint += fmt.Sprintf("-%08x", h.Sum32())
	}
	done()

	hoot.PruneStaleCaches(cacheDir, 24*time.Hour)

	cached, err := hoot.LoadMetaCache(cacheDir, dbName)
	if err != nil {
		log.Warn("meta_cache_read_fail", "err", err)
	}
	if cached != nil && cached.Fingerprint == fingerprint {
		log.Info("meta_cache_hit", "fingerprint", fingerprint)
		hoot.TouchMetaCache(cacheDir, dbName)
		return cached.Meta, nil
	}

	done = log.Step("meta_fetch")
	meta, err := hoot.Fetch(rodBrowser, metaURL, cookie)
	if err != nil {
		return nil, err
	}
	done()

	if saveErr := hoot.SaveMetaCache(cacheDir, dbName, fingerprint, meta); saveErr != nil {
		log.Warn("meta_cache_write_fail", "err", saveErr)
	}
	return meta, nil
}

func fetchMetaUncached(rodBrowser *rod.Browser, metaURL string, cookie *auth.Cookie) (*hoot.Metadata, error) {
	done := log.Step("meta_fetch")
	meta, err := hoot.Fetch(rodBrowser, metaURL, cookie)
	if err != nil {
		return nil, err
	}
	done()
	return meta, nil
}

func isLocalServer(serverURL string) bool {
	parsed, err := url.Parse(serverURL)
	if err != nil {
		return false
	}
	switch parsed.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		return true
	default:
		return false
	}
}

func drain(out <-chan event, runNum int, runUntilFail bool, onFailure func()) int {
	totalPassed, totalFailed := 0, 0

	for workerEvent := range out {
		switch workerEvent.kind {
		case kindFailure:
			log.TestFail(workerEvent.worker, workerEvent.id, workerEvent.name, workerEvent.url, workerEvent.stack)
			onFailure()

		case kindDone:
			log.Info("worker_done", "worker", workerEvent.worker, "passed", workerEvent.passed, "failed", workerEvent.failed)
			totalPassed += workerEvent.passed
			totalFailed += workerEvent.failed
			if workerEvent.failed > 0 {
				onFailure()
			}

		case kindError:
			log.Error("worker_error", "worker", workerEvent.worker, "err", workerEvent.stack)
			totalFailed++
		}
	}

	log.RunDone(runNum, totalPassed, totalFailed, totalPassed+totalFailed, runUntilFail && totalFailed == 0)
	if totalFailed > 0 {
		return 1
	}
	return 0
}
