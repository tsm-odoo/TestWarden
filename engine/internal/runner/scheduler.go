package runner

import (
	"fmt"
	"strings"

	"test-warden/internal/hoot"
)

// Resolves the set of test IDs to run from metadata, applying suite/test filters and the
// preset/skip tag rules.
func FilterIDs(meta *hoot.Metadata, suiteNames []string, testID string, mobile bool) ([]string, error) {
	if testID != "" {
		ref := hoot.ParseTestRef(testID)
		if !ref.IsName() {
			if _, ok := meta.TestByID[ref.ID()]; ok {
				return []string{ref.ID()}, nil
			}
			return nil, fmt.Errorf("test not found: %s", ref)
		}
		needle := strings.ToLower(ref.String())
		var matchID string
		var matchNames []string
		for id, test := range meta.TestByID {
			if strings.Contains(strings.ToLower(test.Name), needle) {
				matchID = id
				matchNames = append(matchNames, test.Name)
			}
		}
		switch len(matchNames) {
		case 0:
			return nil, fmt.Errorf("test not found: %s", ref)
		case 1:
			return []string{matchID}, nil
		default:
			return nil, fmt.Errorf("ambiguous test name %q matches multiple tests: %s", ref, strings.Join(matchNames, ", "))
		}
	}
	if len(suiteNames) > 0 {
		nameToID := make(map[string]string, len(meta.SuiteByID))
		for suiteID, suite := range meta.SuiteByID {
			nameToID[suite.Name] = suiteID
		}
		seen := make(map[string]bool)
		var ids []string
		for _, name := range suiteNames {
			suiteID, ok := nameToID[name]
			if !ok {
				return nil, fmt.Errorf("unknown suite: %q", name)
			}
			for _, test := range meta.TestsBySuiteID[suiteID] {
				if !seen[test.ID] && isRunnable(test.Tags, mobile) {
					seen[test.ID] = true
					ids = append(ids, test.ID)
				}
			}
		}
		return ids, nil
	}
	var ids []string
	for testID, test := range meta.TestByID {
		if isRunnable(test.Tags, mobile) {
			ids = append(ids, testID)
		}
	}
	return ids, nil
}

func isRunnable(tags []string, mobile bool) bool {
	otherPreset := "mobile"
	if mobile {
		otherPreset = "desktop"
	}
	for _, tag := range tags {
		if tag == "skip" || tag == otherPreset {
			return false
		}
	}
	return true
}

// Splits ids into at most workers slices, each with at least minLoad items.
func SplitTests(ids []string, workers, minLoad int) [][]string {
	if len(ids) == 0 {
		return nil
	}
	workerCount := workers
	if minLoad > 0 && len(ids)/workerCount < minLoad {
		workerCount = len(ids) / minLoad
	}
	if workerCount < 1 {
		workerCount = 1
	}
	size := (len(ids) + workerCount - 1) / workerCount
	var splits [][]string
	for i := 0; i < len(ids); i += size {
		end := i + size
		if end > len(ids) {
			end = len(ids)
		}
		splits = append(splits, ids[i:end])
	}
	return splits
}
