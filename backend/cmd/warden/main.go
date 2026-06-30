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

func (s *stringSlice) String() string { return strings.Join(*s, ",") }
func (s *stringSlice) Set(v string) error {
	for _, part := range strings.Split(v, ",") {
		if p := strings.TrimSpace(part); p != "" {
			*s = append(*s, p)
		}
	}
	return nil
}

// settings mirrors the relevant fields of settings.json.
type settings struct {
	Repositories map[string]string `json:"repositories"`
	Suites       map[string]string `json:"suites"`
	Chrome       string            `json:"chrome"`
	MinLoad      int               `json:"minLoad"`
}

func loadSettings(path string) (settings, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return settings{}, err
	}
	var s settings
	if err := json.Unmarshal(data, &s); err != nil {
		return settings{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return s, nil
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
	flag.BoolVar(&cfg.FailFast, "fail-fast", false, "Stop on first failure (bail=1)")
	flag.BoolVar(&cfg.RunUntilFail, "run-until-fail", false, "Re-run tests until a failure is found")
	flag.BoolVar(&cfg.Visible, "visible", false, "Run in visible browser with devtools and full-screen window")
	flag.BoolVar(&cfg.PauseOnFail, "pause-on-fail", false, "Keep browser open after failure; press Ctrl+C to exit")

	hidden := map[string]bool{"rod": true}
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: warden [flags]\n\nFlags:\n")
		flag.VisitAll(func(f *flag.Flag) {
			if !hidden[f.Name] {
				fmt.Fprintf(os.Stderr, "  -%s\n    \t%s\n", f.Name, f.Usage)
				if f.DefValue != "" && f.DefValue != "false" {
					fmt.Fprintf(os.Stderr, "    \t(default %q)\n", f.DefValue)
				}
			}
		})
		fmt.Fprintf(os.Stderr, "\nExamples:\n")
		fmt.Fprintf(os.Stderr, "  warden --workers 4\n")
		fmt.Fprintf(os.Stderr, "  warden --suite qunit --suite-names web,mail --workers 2\n")
		fmt.Fprintf(os.Stderr, "  warden --test \"Form view renders correctly\"\n")
		fmt.Fprintf(os.Stderr, "  warden --fail-fast --workers 2\n")
	}
	flag.Parse()

	cfg.SuiteNames = suiteNames

	s, _ := loadSettings("settings.json")
	for _, path := range s.Repositories {
		cfg.AddonsPath = append(cfg.AddonsPath, path)
	}
	if cfg.SuitePath == "" {
		if path, ok := s.Suites[suite]; ok {
			cfg.SuitePath = path
		} else {
			cfg.SuitePath = "/web/tests"
		}
	}
	if s.Chrome != "" {
		cfg.ChromePath = s.Chrome
	}
	cfg.MinLoad = s.MinLoad
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
