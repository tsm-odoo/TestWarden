package browser

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"

	"context"

	"github.com/go-rod/rod/lib/launcher"

	"test-warden/internal/log"
)

func shellBinPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cache", "warden", "chrome-headless-shell", "chrome-headless-shell"), nil
}

func downloadShell(bin string) error {
	resp, err := http.Get("https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json")
	if err != nil {
		return fmt.Errorf("fetch metadata: %w", err)
	}
	defer resp.Body.Close()

	var meta struct {
		Channels map[string]struct {
			Downloads map[string][]struct {
				Platform string `json:"platform"`
				URL      string `json:"url"`
			} `json:"downloads"`
		} `json:"channels"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
		return fmt.Errorf("parse metadata: %w", err)
	}

	platform := cftPlatform()
	var downloadURL string
	for _, entry := range meta.Channels["Stable"].Downloads["chrome-headless-shell"] {
		if entry.Platform == platform {
			downloadURL = entry.URL
			break
		}
	}
	if downloadURL == "" {
		return fmt.Errorf("no download found for platform %s", platform)
	}

	zipResp, err := http.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("download zip: %w", err)
	}
	defer zipResp.Body.Close()
	zipData, err := io.ReadAll(zipResp.Body)
	if err != nil {
		return fmt.Errorf("read zip: %w", err)
	}

	zipReader, err := zip.NewReader(bytes.NewReader(zipData), int64(len(zipData)))
	if err != nil {
		return fmt.Errorf("open zip: %w", err)
	}
	dir := filepath.Dir(bin)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	// Extract every file -- chrome-headless-shell requires icudtl.dat and other
	// sibling files to be present in the same directory.
	found := false
	for _, zipEntry := range zipReader.File {
		if zipEntry.FileInfo().IsDir() {
			continue
		}
		dest := filepath.Join(dir, filepath.Base(zipEntry.Name))
		readCloser, err := zipEntry.Open()
		if err != nil {
			return err
		}
		mode := zipEntry.Mode()
		if mode == 0 {
			mode = 0644
		}
		outFile, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
		if err != nil {
			readCloser.Close()
			return err
		}
		_, err = io.Copy(outFile, readCloser)
		readCloser.Close()
		outFile.Close()
		if err != nil {
			return err
		}
		if filepath.Base(zipEntry.Name) == "chrome-headless-shell" {
			found = true
		}
	}
	if !found {
		return fmt.Errorf("chrome-headless-shell not found in zip")
	}
	return nil
}

func cftPlatform() string {
	switch runtime.GOOS {
	case "darwin":
		if runtime.GOARCH == "arm64" {
			return "mac-arm64"
		}
		return "mac-x64"
	case "windows":
		return "win64"
	default:
		return "linux64"
	}
}

// freePort returns the first TCP port >= start that is not currently in use.
func freePort(start int) (int, error) {
	for port := start; port < start+100; port++ {
		listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
		if err != nil {
			continue
		}
		listener.Close()
		return port, nil
	}
	return 0, fmt.Errorf("no free port found in range %d-%d", start, start+99)
}

func Launch(ctx context.Context, chromePath string, visible bool) (wsURL string, kill func(), err error) {
	var bin string

	if !visible {
		bin = chromePath
		if bin == "" {
			bin, err = shellBinPath()
			if err != nil {
				return "", nil, err
			}
		}
		if _, statErr := os.Stat(bin); os.IsNotExist(statErr) {
			done := log.Step("download_chrome_shell")
			if dlErr := downloadShell(bin); dlErr != nil {
				return "", nil, fmt.Errorf("download chrome-headless-shell: %w", dlErr)
			}
			done()
		}
	} else {
		bin = chromePath
	}

	port, err := freePort(9222)
	if err != nil {
		return "", nil, fmt.Errorf("find free port: %w", err)
	}

	chromeLaunch := launcher.New().Headless(false)
	if bin != "" {
		chromeLaunch = chromeLaunch.Bin(bin)
	}
	chromeLaunch = chromeLaunch.Set("no-sandbox").
		Set("no-zygote").
		// Set("js-flags", "--expose-gc"). Not needed since cgroup can already limit RAM usage?
		Set("no-first-run").
		Set("no-default-browser-check").
		Set("disable-dev-shm-usage").
		Set("disable-extensions").
		Set("disable-background-networking").
		Set("disable-background-timer-throttling").
		Set("disable-backgrounding-occluded-windows").
		Set("disable-renderer-backgrounding").
		Set("disable-breakpad").
		Set("disable-sync").
		Set("disable-translate").
		Set("disable-default-apps").
		Set("disable-domain-reliability").
		Set("disable-component-extensions-with-background-pages").
		Set("disable-features", "PaintHolding,IsolateOrigins,site-per-process,MediaRouter,AudioServiceOutOfProcess,DestroyProfileOnBrowserClose").
		Set("mute-audio").
		Set("remote-debugging-port", strconv.Itoa(port)).
		Set("remote-allow-origins", "*").
		Logger(io.Discard)

	if visible {
		chromeLaunch = chromeLaunch.Set("start-maximized").
			Set("auto-open-devtools-for-tabs")
	} else {
		chromeLaunch = chromeLaunch.
			Set("disable-gpu").
			Set("disable-software-rasterizer").
			Set("disable-accelerated-2d-canvas").
			Set("window-size", "1366,768")
	}

	url, err := chromeLaunch.Context(ctx).Launch()
	if err != nil {
		return "", nil, err
	}
	return url, chromeLaunch.Cleanup, nil
}
