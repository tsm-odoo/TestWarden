package runner

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/go-rod/rod"

	"test-warden/internal/auth"
	"test-warden/internal/browser"
	"test-warden/internal/hoot"
	"test-warden/internal/log"
)

type Config struct {
	ServerURL    string
	SuitePath    string
	SuiteNames   []string
	TestID       string
	Workers      int
	MinLoad      int
	ChromePath   string
	AddonsPath   []string // directories to scan for *.test.js; enables metadata cache
	CacheDir     string   // where to store the cache (default: ".cache")
	FailFast     bool     // stop workers on first failure (bail=1)
	RunUntilFail bool     // re-run until a test fails, reloading pages between runs
	Visible      bool     // launch a visible browser with devtools
	PauseOnFail  bool     // keep browser open after failure until Ctrl+C
}

// Run is the top-level entry point. Returns an exit code (0, 1, or 2).
func Run(ctx context.Context, cfg Config) int {
	done := log.Step("chrome_launch")
	wsURL, killChrome, err := browser.Launch(ctx, cfg.ChromePath, cfg.Visible)
	if err != nil {
		log.Error("chrome_launch", "err", err)
		return 2
	}
	defer killChrome()
	done()
	b := rod.New().ControlURL(wsURL).Context(ctx).MustConnect()
	defer b.Close()

	done = log.Step("db_fetch", "server", cfg.ServerURL)
	db, err := auth.GetDatabase(cfg.ServerURL)
	if err != nil {
		log.Error("db_fetch", "err", err)
		return 2
	}
	done()

	done = log.Step("auth", "db", db)
	cookie, err := auth.Authenticate(cfg.ServerURL, db, "admin", "admin")
	if err != nil {
		log.Error("auth", "err", err)
		return 2
	}
	done()

	meta, err := loadMeta(b, cfg, db, cookie)
	if err != nil {
		log.Error("meta_fetch", "err", err)
		return 2
	}

	wcfg := workerConfig{
		serverURL: cfg.ServerURL,
		suitePath: cfg.SuitePath,
		cookie:    cookie,
		meta:      meta,
		failFast:  cfg.FailFast,
		browserWS: wsURL,
		debugTest: cfg.Visible && cfg.TestID != "",
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

	chunks := Chunk(testIDs, cfg.Workers, cfg.MinLoad)
	log.Info("tests_resolve", "total", len(testIDs), "workers", len(chunks))

	// Create browser pages once (workers_launch). Pages are reused across runs.
	done = log.Step("workers_launch", "n", len(chunks))
	pages := make([]*rod.Page, len(chunks))
	setupOK := make([]bool, len(chunks))
	navReady := make(chan struct{}, len(chunks))

	var setupWg sync.WaitGroup
	for i, chunk := range chunks {
		setupWg.Add(1)
		go func(id int, ids []string) {
			defer setupWg.Done()
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
		for _, p := range pages {
			if p != nil {
				p.Close()
			}
		}
	}()

	for i := range chunks {
		if !setupOK[i] {
			return 2
		}
	}

	// Run loop: navigate (or reload) each page and collect results.
	for runNum := 1; ; runNum++ {
		log.Info("run_start", "run", runNum, "total", len(testIDs))

		out := make(chan event, 256)
		var wg sync.WaitGroup

		for i, chunk := range chunks {
			wg.Add(1)
			go func(id int, ids []string, page *rod.Page) {
				defer wg.Done()
				if err := execPage(ctx, page, id, ids, wcfg, out); err != nil {
					out <- event{kind: kindError, worker: id, stack: err.Error()}
				}
			}(i, chunk, pages[i])
		}

		go func() {
			wg.Wait()
			close(out)
		}()

		code := drain(out, runNum)
		if code != 0 {
			if cfg.PauseOnFail && !cfg.RunUntilFail {
				fmt.Fprintf(os.Stderr, "\nBrowser paused after failure. Open devtools URLs from the log above.\nPress Ctrl+C to exit.\n")
				<-ctx.Done()
			}
			if !cfg.RunUntilFail {
				return code
			}
			log.Info("run_wait")
			scanner := bufio.NewScanner(os.Stdin)
			if !scanner.Scan() {
				return code
			}
			line := strings.TrimSpace(strings.ToLower(scanner.Text()))
			if line != "y" && line != "yes" && line != "" {
				return code
			}
			// fall through to next run
		} else if !cfg.RunUntilFail {
			return 0
		}
	}
}

func loadMeta(b *rod.Browser, cfg Config, db string, cookie *auth.Cookie) (*hoot.Metadata, error) {
	metaURL := hoot.MetaURL(cfg.ServerURL, cfg.SuitePath)

	if len(cfg.AddonsPath) == 0 {
		done := log.Step("meta_fetch")
		meta, err := hoot.Fetch(b, metaURL, cookie)
		if err != nil {
			return nil, err
		}
		done()
		return meta, nil
	}

	cacheDir := cfg.CacheDir
	if cacheDir == "" {
		cacheDir = ".cache"
	}

	done := log.Step("meta_fingerprint")
	fp, err := hoot.FingerprintDirs(cfg.AddonsPath)
	if err != nil {
		return nil, fmt.Errorf("fingerprint addons: %w", err)
	}
	done()

	cached, err := hoot.LoadMetaCache(cacheDir, db, cfg.SuitePath)
	if err != nil {
		log.Warn("meta_cache_read_fail", "err", err)
	}
	if cached != nil && cached.Fingerprint == fp {
		log.Info("meta_cache_hit", "fingerprint", fp)
		return cached.Meta, nil
	}

	done = log.Step("meta_fetch")
	meta, err := hoot.Fetch(b, metaURL, cookie)
	if err != nil {
		return nil, err
	}
	done()

	if saveErr := hoot.SaveMetaCache(cacheDir, db, cfg.SuitePath, fp, meta); saveErr != nil {
		log.Warn("meta_cache_write_fail", "err", saveErr)
	}
	return meta, nil
}

func drain(out <-chan event, runNum int) int {
	totalPassed, totalFailed := 0, 0

	for ev := range out {
		switch ev.kind {
		case kindFailure:
			log.Error("test_fail", "worker", ev.worker, "id", ev.id, "test", ev.name, "url", ev.url, "stack", ev.stack)

		case kindDone:
			log.Info("worker_done", "worker", ev.worker, "passed", ev.passed, "failed", ev.failed)
			totalPassed += ev.passed
			totalFailed += ev.failed

		case kindError:
			log.Error("worker_error", "worker", ev.worker, "err", ev.stack)
			totalFailed++
		}
	}

	log.Info("run_done", "run", runNum, "passed", totalPassed, "failed", totalFailed, "total", totalPassed+totalFailed)
	if totalFailed > 0 {
		return 1
	}
	return 0
}
