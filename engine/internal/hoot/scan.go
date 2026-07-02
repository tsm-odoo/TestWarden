package hoot

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

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

// Walks roots for *.test.js files and returns a hex string that changes whenever any file
// is added, removed, or modified.
func FingerprintDirs(roots []string) (string, error) {
	var hashVal int32
	for _, root := range roots {
		dirs, err := findTestsDirs(root)
		if err != nil {
			return "", fmt.Errorf("fingerprint %s: %w", root, err)
		}
		for _, testDir := range dirs {
			if err := filepath.WalkDir(testDir, func(path string, dirEntry os.DirEntry, err error) error {
				if err != nil || dirEntry.IsDir() || !strings.HasSuffix(path, ".test.js") {
					return err
				}
				info, err := dirEntry.Info()
				if err != nil {
					return nil
				}
				for _, pathByte := range []byte(path) {
					hashVal = (hashVal << 5) - hashVal + int32(pathByte)
				}
				mtime := info.ModTime().UnixNano()
				for i := 0; i < 8; i++ {
					hashVal = (hashVal << 5) - hashVal + int32(mtime&0xff)
					mtime >>= 8
				}
				return nil
			}); err != nil {
				return "", err
			}
		}
	}
	return fmt.Sprintf("%08x", uint32(hashVal)), nil
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

// Returns all {addon}/static/tests directories under root.
func findTestsDirs(root string) ([]string, error) {
	var result []string
	err := filepath.WalkDir(root, func(path string, dirEntry os.DirEntry, err error) error {
		if err != nil || !dirEntry.IsDir() {
			return nil
		}
		name := dirEntry.Name()
		switch name {
		case "node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build",
			"models", "views", "controllers", "security", "data", "report",
			"wizard", "i18n", "migrations", "populate", "demo":
			return filepath.SkipDir
		}
		if filepath.Base(filepath.Dir(path)) == "static" {
			if name == "tests" {
				result = append(result, path)
			}
			return filepath.SkipDir
		}
		return nil
	})
	return result, err
}

func sanitizeFilename(name string) string {
	replacer := strings.NewReplacer("/", "_", ":", "_", " ", "_")
	return replacer.Replace(name)
}
