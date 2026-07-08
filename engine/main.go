package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"test-warden/internal/runner"
)

// stringSlice is a flag.Value that accumulates comma-separated or repeated values.
type stringSlice []string

func (slice *stringSlice) String() string { return strings.Join(*slice, ",") }
func (slice *stringSlice) Set(value string) error {
	for _, part := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			*slice = append(*slice, trimmed)
		}
	}
	return nil
}

// settings mirrors the relevant fields of settings.json.
type settings struct {
	WorktreeContainer string            `json:"worktreeContainer"`
	Suites            map[string]string `json:"suites"`
	Chrome            string            `json:"chrome"`
	MinLoad           int               `json:"minLoad"`
}

func loadSettings(path string) (settings, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return settings{}, err
	}
	var loaded settings
	if err := json.Unmarshal(data, &loaded); err != nil {
		return settings{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return loaded, nil
}

func main() {
	cfg := runner.Config{}
	var suiteNames stringSlice
	var suite string

	flag.StringVar(&cfg.ServerURL, "server", "http://localhost:8069", "Odoo server URL")
	flag.StringVar(&cfg.SuitePath, "suite-path", "", "URL path of the test suite (overrides --suite lookup)")
	flag.StringVar(&suite, "suite", "hoot", "Suite type (hoot, qunit, livechat…); resolved via settings.json suites map")
	flag.Var(&suiteNames, "suite-names", "Suite names to run, comma-separated")
	flag.StringVar(&cfg.TestID, "test", "", "Run a single test by ID or name")
	flag.IntVar(&cfg.Workers, "workers", 4, "Number of parallel browser contexts")
	flag.IntVar(&cfg.CPUThrottling, "cpu-throttling", 0, "CPU throttling factor (0-100)")
	flag.BoolVar(&cfg.FailFast, "fail-fast", false, "Stop on first failure (bail=1)")
	flag.BoolVar(&cfg.RunUntilFail, "run-until-fail", false, "Re-run tests until a failure is found")
	flag.IntVar(&cfg.FlakyRuns, "flaky-check", 0, "Repeat a single test N times total (split across workers) without stopping on failure, then report a pass/fail ratio (requires --test)")
	flag.BoolVar(&cfg.Visible, "visible", false, "Run in visible browser with devtools and full-screen window")
	flag.BoolVar(&cfg.PauseBeforeExit, "pause-before-exit", false, "Keep browser open after failure; press any key to quit")
	flag.BoolVar(&cfg.Debug, "debug", false, "Pause for interactive debugging on a single test (implies --pause-before-exit --workers 1)")

	hidden := map[string]bool{"rod": true}
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: warden [flags]\n\nFlags:\n")
		flag.VisitAll(func(flagEntry *flag.Flag) {
			if !hidden[flagEntry.Name] {
				fmt.Fprintf(os.Stderr, "  -%s\n    \t%s\n", flagEntry.Name, flagEntry.Usage)
				if flagEntry.DefValue != "" && flagEntry.DefValue != "false" {
					fmt.Fprintf(os.Stderr, "    \t(default %q)\n", flagEntry.DefValue)
				}
			}
		})
		fmt.Fprintf(os.Stderr, "\nExamples:\n")
		fmt.Fprintf(os.Stderr, "  warden --workers 4\n")
		fmt.Fprintf(os.Stderr, "  warden --suite qunit --suite-names web,mail --workers 2\n")
		fmt.Fprintf(os.Stderr, "  warden --test \"Form view renders correctly\"\n")
		fmt.Fprintf(os.Stderr, "  warden --fail-fast --workers 2\n")
		fmt.Fprintf(os.Stderr, "  warden --test \"Form view renders correctly\" --debug\n")
		fmt.Fprintf(os.Stderr, "  warden --test \"Form view renders correctly\" --flaky-check 50\n")
	}
	flag.Parse()

	cfg.SuiteNames = suiteNames

	if cfg.Visible {
		cfg.Workers = 1
	}

	appSettings, _ := loadSettings("settings.json")
	cfg.WorktreeContainer = appSettings.WorktreeContainer
	if cfg.SuitePath == "" {
		if path, ok := appSettings.Suites[suite]; ok {
			cfg.SuitePath = path
		} else {
			cfg.SuitePath = "/web/tests"
		}
	}
	if appSettings.Chrome != "" {
		cfg.ChromePath = appSettings.Chrome
	}
	cfg.MinLoad = appSettings.MinLoad
	if cfg.MinLoad == 0 {
		cfg.MinLoad = 15
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Force-exit if Run doesn't return promptly after cancellation.
	// Chrome is a child process so the OS reaps it when we die.
	go func() {
		<-ctx.Done()
		os.Exit(130)
	}()

	os.Exit(runner.Run(ctx, cfg))
}
