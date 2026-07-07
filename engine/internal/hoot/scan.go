package hoot

import (
	"bytes"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var testToken = []byte("test")

// test(...) itself, plus the variants that are still a test declaration (just marked
// only/skip/todo), each mapped to how many bytes to skip past "test" to reach the name arg.
var testSuffixes = []([]byte){
	[]byte("("),
	[]byte(".only("),
	[]byte(".skip("),
	[]byte(".todo("),
}

func isWordByte(b byte) bool {
	return b == '_' || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

func isSpaceByte(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

// Extracts the name of every test(...)/test.only(...)/test.skip(...)/test.todo(...)
// declaration in content via a plain byte scan. Naive but enough to tell "a test was
// added/removed/renamed".
func extractTestNames(content []byte) []string {
	var names []string
	pos := 0
	for {
		// checking against the "test" sentinel
		idx := bytes.Index(content[pos:], testToken)
		if idx < 0 {
			break
		}
		start := pos + idx
		afterTest := start + len(testToken)
		pos = afterTest // default advance if this occurrence doesn't pan out
		// excluding foo.test( / sometest / testSomething
		if start > 0 && (isWordByte(content[start-1]) || content[start-1] == '.') {
			continue
		}
		if afterTest < len(content) && isWordByte(content[afterTest]) {
			continue
		}
		// matching one of test(/.only(/.skip(/.todo(
		next := -1
		for _, suffix := range testSuffixes {
			if bytes.HasPrefix(content[afterTest:], suffix) {
				next = afterTest + len(suffix)
				break
			}
		}
		if next < 0 {
			continue // e.g. test.tags(, test.timeout(, or a bare "test" identifier
		}
		pos = next
		// skipping whitespace before the name arg
		i := next
		for i < len(content) && isSpaceByte(content[i]) {
			i++
		}
		if i >= len(content) {
			break
		}
		// looking for quotes
		quote := content[i]
		if quote != '"' && quote != '\'' && quote != '`' {
			continue
		}
		i++
		nameStart := i
		// scanning to the matching closing quote, skipping \-escaped chars
		for i < len(content) && content[i] != quote {
			if content[i] == '\\' && i+1 < len(content) {
				i += 2
				continue
			}
			i++
		}
		if i >= len(content) {
			break
		}
		names = append(names, string(content[nameStart:i]))
	}
	sort.Strings(names)
	return names
}

// Holds hoot metadata alongside a fingerprint of the *.test.js files that were present
// when it was fetched. If the fingerprint matches on the next run, the fetch is skipped.
type metadataCacheFile struct {
	Fingerprint string    `json:"fingerprint"`
	Meta        *Metadata `json:"meta"`
}

// Reads a previously saved metadata cache for dbName. Returns nil, nil if the file is
// missing or corrupt.
func LoadMetaCache(cacheDir, dbName string) (*metadataCacheFile, error) {
	path := filepath.Join(cacheDir, sanitizeFilename(dbName)+".meta.json")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var cached metadataCacheFile
	if err := json.Unmarshal(data, &cached); err != nil {
		return nil, nil // corrupt → treat as miss
	}
	return &cached, nil
}

// Bumps a cache file's mtime to now, marking it as still in use so PruneStaleCaches
// doesn't drop it even though it wasn't rewritten (cache hit).
func TouchMetaCache(cacheDir, dbName string) {
	now := time.Now()
	path := filepath.Join(cacheDir, sanitizeFilename(dbName)+".meta.json")
	_ = os.Chtimes(path, now, now)
}

// Removes *.meta.json files under cacheDir that haven't been read or written in longer
// than maxAge, so caches for databases no longer in use don't accumulate forever.
func PruneStaleCaches(cacheDir string, maxAge time.Duration) {
	entries, err := os.ReadDir(cacheDir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-maxAge)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".meta.json") {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		_ = os.Remove(filepath.Join(cacheDir, entry.Name()))
	}
}

// Writes meta to cacheDir/<dbName>.meta.json with the given fingerprint.
func SaveMetaCache(cacheDir, dbName, fingerprint string, meta *Metadata) error {
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return fmt.Errorf("create cache dir: %w", err)
	}
	data, err := json.Marshal(metadataCacheFile{Fingerprint: fingerprint, Meta: meta})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(cacheDir, sanitizeFilename(dbName)+".meta.json"), data, 0644)
}

// TestDir pairs a discovered {addon}/static/tests directory with its addon's name, so
// FingerprintTestDirs can filter by installed modules without re-walking the filesystem.
type TestDir struct {
	Addon string
	Path  string
}

// Finds every {addon}/static/tests directory under roots. A pure filesystem walk with no
// network dependency, so callers can run it concurrently with an installed-modules RPC and
// filter the result afterward via FingerprintTestDirs, rather than serializing the two.
func FindTestDirs(roots []string) ([]TestDir, error) {
	var result []TestDir
	for _, root := range roots {
		err := filepath.WalkDir(root, func(path string, dirEntry os.DirEntry, err error) error {
			if err != nil || !dirEntry.IsDir() {
				return nil
			}
			switch dirEntry.Name() {
			case "node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build",
				"models", "views", "controllers", "security", "data", "report",
				"wizard", "i18n", "migrations", "populate", "demo":
				return filepath.SkipDir
			}
			if dirEntry.Name() == "tests" && filepath.Base(filepath.Dir(path)) == "static" {
				addon := filepath.Base(filepath.Dir(filepath.Dir(path)))
				result = append(result, TestDir{Addon: addon, Path: path})
				return filepath.SkipDir
			}
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("find test dirs %s: %w", root, err)
		}
	}
	return result, nil
}

// Hashes the *.test.js test declarations under dirs into a fingerprint that changes
// whenever a test is added, removed, or renamed.
func FingerprintTestDirs(dirs []TestDir, installedModules []string) (string, error) {
	var installedSet map[string]bool
	if installedModules != nil {
		installedSet = make(map[string]bool, len(installedModules))
		for _, name := range installedModules {
			installedSet[name] = true
		}
	}
	hasher := fnv.New64a()
	for _, dir := range dirs {
		if installedSet != nil && !installedSet[dir.Addon] {
			continue
		}
		if err := filepath.WalkDir(dir.Path, func(path string, dirEntry os.DirEntry, err error) error {
			if err != nil || dirEntry.IsDir() || !strings.HasSuffix(path, ".test.js") {
				return err
			}
			content, readErr := os.ReadFile(path)
			if readErr != nil {
				return nil
			}
			hasher.Write([]byte(path))
			for _, name := range extractTestNames(content) {
				hasher.Write([]byte(name))
			}
			return nil
		}); err != nil {
			return "", err
		}
	}
	return fmt.Sprintf("%016x", hasher.Sum64()), nil
}

// Searches container for a directory named dbName, at any depth, and returns its path.
// Returns "" if not found. Skips common heavy/irrelevant directories to keep the walk fast.
func FindWorktreeDir(container, dbName, cacheDir string) (string, error) {
	index := loadRepoIndex(cacheDir)
	if cached, ok := index[dbName]; ok {
		if info, err := os.Stat(cached); err == nil && info.IsDir() && filepath.Base(cached) == dbName {
			return cached, nil
		}
	}
	found, err := walkForWorktreeDir(container, dbName)
	if err != nil {
		return "", err
	}
	if found != "" {
		index[dbName] = found
		_ = saveRepoIndex(cacheDir, index)
	}
	return found, nil
}

func walkForWorktreeDir(container, dbName string) (string, error) {
	var found string
	err := filepath.WalkDir(container, func(path string, dirEntry os.DirEntry, err error) error {
		if err != nil || !dirEntry.IsDir() {
			return nil
		}
		name := dirEntry.Name()
		if name == dbName {
			found = path
			return filepath.SkipAll
		}
		switch name {
		case "node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build":
			return filepath.SkipDir
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return found, nil
}

func repoIndexPath(cacheDir string) string {
	return filepath.Join(cacheDir, "repo_index.json")
}

// Reads the dbName -> worktree path index. Missing/corrupt files are treated as empty.
func loadRepoIndex(cacheDir string) map[string]string {
	index := make(map[string]string)
	data, err := os.ReadFile(repoIndexPath(cacheDir))
	if err != nil {
		return index
	}
	_ = json.Unmarshal(data, &index)
	return index
}

func saveRepoIndex(cacheDir string, index map[string]string) error {
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return fmt.Errorf("create cache dir: %w", err)
	}
	data, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(repoIndexPath(cacheDir), data, 0644)
}

func sanitizeFilename(name string) string {
	replacer := strings.NewReplacer("/", "_", ":", "_", " ", "_")
	return replacer.Replace(name)
}
