package runner

import (
	"fmt"

	"test-warden/internal/hoot"
)

// FilterIDs resolves the set of test IDs to run from metadata, applying
// suite/test filters and the desktop/skip tag rules.
func FilterIDs(meta *hoot.Metadata, suiteNames []string, testID string) ([]string, error) {
	if testID != "" {
		ref := hoot.ParseTestRef(testID)
		if !ref.IsName() {
			if _, ok := meta.TestByID[ref.ID()]; ok {
				return []string{ref.ID()}, nil
			}
			return nil, fmt.Errorf("test not found: %s", ref)
		}
		for id, test := range meta.TestByID {
			if test.Name == ref.String() {
				return []string{id}, nil
			}
		}
		return nil, fmt.Errorf("test not found: %s", ref)
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
				if !seen[test.ID] && isRunnable(test.Tags) {
					seen[test.ID] = true
					ids = append(ids, test.ID)
				}
			}
		}
		return ids, nil
	}
	var ids []string
	for testID, test := range meta.TestByID {
		if isRunnable(test.Tags) {
			ids = append(ids, testID)
		}
	}
	return ids, nil
}

func isRunnable(tags []string) bool {
	for _, tag := range tags {
		switch tag {
		case "skip", "mobile":
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
