package hoot

import (
	"fmt"
	"net/url"
	"strings"
)

func IsMobilePreset(suitePath string) bool {
	parsed, err := url.Parse(suitePath)
	return err == nil && parsed.Query().Get("preset") == "mobile"
}

// Returns a URL that loads Hoot without starting tests.
func MetaURL(serverURL, suitePath string) string {
	return fmt.Sprintf("%s%s?debug=assets&timeout=15000&loglevel=0&manual=true", serverURL, suitePath)
}

// Returns a URL for a worker to run a specific set of tests. bail=true adds &bail=1 to
// stop on the first failure. debugTest=true adds &debugTest=true to pause the runner for
// interactive debugging. debugLogs=true raises Hoot's log level from "tests" (2: test starts,
// suite ends and failures, all the engine reads) to "debug" (3), which also logs every
// dispatched event and assertion: only worth its cost when someone reads the page's console,
// as each line goes through CDP to the engine.
func WorkerURL(serverURL, suitePath string, testIDs []string, bail, debugTest, debugLogs bool) string {
	logLevel := 2
	if debugLogs {
		logLevel = 3
	}
	base := fmt.Sprintf("%s%s?debug=assets&timeout=15000&loglevel=%d&showdetail=failed&manual=true", serverURL, suitePath, logLevel)
	if bail {
		base += "&bail=1"
	}
	if debugTest {
		base += "&debugTest=true"
	}
	if len(testIDs) == 0 {
		return base
	}
	ids := make([]string, len(testIDs))
	for i, id := range testIDs {
		ids[i] = "id=" + id
	}
	return base + "&" + strings.Join(ids, "&")
}

// Returns a URL to reproduce a single failing test with debug enabled.
func DebugURL(serverURL, suitePath, testID string) string {
	return fmt.Sprintf("%s%s?debug=assets&id=%s&debugTest=true", serverURL, suitePath, testID)
}
