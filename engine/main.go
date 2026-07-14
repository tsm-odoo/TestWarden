package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"

	"test-warden/internal/log"
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

// Mirrors the relevant fields of settings.json.
type settings struct {
	WorktreeContainer string            `json:"worktreeContainer"`
	Suites            map[string]string `json:"suites"`
	Chrome            string            `json:"chrome"`
	MinLoad           int               `json:"minLoad"`
	MemoryLimit       string            `json:"memoryLimit"`
	Workers           int               `json:"workers"`
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

// Marks a process as already running inside the systemd-run scope created
// by reexecInCgroupScope, so it doesn't try to pivot again.
const inSystemdScopeEnv = "IN_SYSTEMD_SCOPE"

// On Linux, re-executes the current binary under `systemd-run --user --scope` with a soft
// MemoryHigh cap so the engine and every Chrome instance it spawns share a bounded memory
// budget.
func reexecInCgroupScope(limit string) {
	if runtime.GOOS != "linux" || limit == "" {
		return
	}
	if os.Getenv(inSystemdScopeEnv) == "true" {
		log.LogLine("info", fmt.Sprintf("ℹ RAM limited by cgroup to %s", log.Dyn(limit)))
		return
	}
	systemdRun, err := exec.LookPath("systemd-run")
	if err != nil {
		return
	}
	self, err := os.Executable()
	if err != nil {
		return
	}
	args := append([]string{
		"--user", "--scope", "--quiet",
		"--unit=" + fmt.Sprintf("WardenEngine-%d", os.Getpid()),
		"-p", "MemoryHigh=" + limit,
		"--", self,
	}, os.Args[1:]...)
	cmd := exec.Command(systemdRun, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = append(os.Environ(), inSystemdScopeEnv+"=true")

	if err := cmd.Start(); err != nil {
		return
	}
	// Relay termination signals to the scoped child.
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	go func() {
		for sig := range sigChan {
			cmd.Process.Signal(sig)
		}
	}()
	waitErr := cmd.Wait()
	signal.Stop(sigChan)
	close(sigChan)
	var exitErr *exec.ExitError
	switch {
	case waitErr == nil:
		os.Exit(0)
	case errors.As(waitErr, &exitErr):
		os.Exit(exitErr.ExitCode())
	default:
		os.Exit(1)
	}
}

func main() {
	appSettings, _ := loadSettings("settings.json")
	reexecInCgroupScope(appSettings.MemoryLimit)

	cfg := runner.Config{}
	var suiteNames stringSlice
	var suite string

	flag.StringVar(&cfg.ServerURL, "server", "http://localhost:8069", "Odoo server URL")
	flag.StringVar(&cfg.SuitePath, "suite-path", "", "URL path of the test suite (overrides --suite lookup)")
	flag.StringVar(&suite, "suite", "hoot", "Suite type (hoot, qunit, livechat…); resolved via settings.json suites map")
	flag.Var(&suiteNames, "suite-names", "Suite names to run, comma-separated")
	flag.StringVar(&cfg.TestID, "test", "", "Run a single test by ID or name")
	defaultWorkers := 4
	if appSettings.Workers > 0 {
		defaultWorkers = appSettings.Workers
	}
	flag.IntVar(&cfg.Workers, "workers", defaultWorkers, "Number of parallel browser contexts")
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

	if cfg.Visible || !cfg.RunUntilFail {
		cfg.Workers = 1
	}

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

	// Force-exit if Run doesn't return promptly after cancellation. Chrome is a child
	// process so the OS reaps it when we die.
	go func() {
		<-ctx.Done()
		os.Exit(130)
	}()

	os.Exit(runner.Run(ctx, cfg))
}
