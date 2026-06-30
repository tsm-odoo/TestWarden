package runner

import (
	"fmt"
	"strings"

	"test-warden/internal/hoot"
)

// FilterIDs resolves the set of test IDs to run from metadata, applying
// suite/test filters and the desktop/skip tag rules from the TS adapter.
func FilterIDs(meta *hoot.Metadata, suiteNames []string, testID string) ([]string, error) {
	if testID != "" {
		ref := hoot.ParseTestRef(testID)
		if _, ok := meta.TestByID[ref.ID()]; ok {
			return []string{ref.ID()}, nil
		}
		return nil, fmt.Errorf("test not found: %s", ref)
	}

	if len(suiteNames) > 0 {
		nameToID := make(map[string]string, len(meta.SuiteByID))
		for id, s := range meta.SuiteByID {
			nameToID[s.Name] = id
		}
		seen := make(map[string]bool)
		var ids []string
		for _, name := range suiteNames {
			if sid, ok := nameToID[name]; ok {
				for _, t := range meta.TestsBySuiteID[sid] {
					if !seen[t.ID] && isRunnable(t.Tags) {
						seen[t.ID] = true
						ids = append(ids, t.ID)
					}
				}
				continue
			}
			// Prefix match: "@mail" selects all suites whose name starts with "@mail/".
			// This lets callers target a whole addon when using the static file scanner,
			// which creates per-file suites (@mail/core/web/thread) rather than a
			// single top-level suite.
			prefix := name + "/"
			matched := false
			for sName, sid := range nameToID {
				if strings.HasPrefix(sName, prefix) {
					matched = true
					for _, t := range meta.TestsBySuiteID[sid] {
						if !seen[t.ID] && isRunnable(t.Tags) {
							seen[t.ID] = true
							ids = append(ids, t.ID)
						}
					}
				}
			}
			if !matched {
				return nil, fmt.Errorf("unknown suite: %q", name)
			}
		}
		return ids, nil
	}

	var ids []string
	for id, t := range meta.TestByID {
		if isRunnable(t.Tags) {
			ids = append(ids, id)
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

// Chunk splits ids into at most workers slices, each with at least minLoad items.
func Chunk(ids []string, workers, minLoad int) [][]string {
	if len(ids) == 0 {
		return nil
	}
	w := workers
	if minLoad > 0 && len(ids)/w < minLoad {
		w = len(ids) / minLoad
	}
	if w < 1 {
		w = 1
	}
	size := (len(ids) + w - 1) / w
	var chunks [][]string
	for i := 0; i < len(ids); i += size {
		end := i + size
		if end > len(ids) {
			end = len(ids)
		}
		chunks = append(chunks, ids[i:end])
	}
	return chunks
}
