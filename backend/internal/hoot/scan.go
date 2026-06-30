package hoot

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// metadataCacheFile holds a browser-fetched Metadata alongside a fingerprint
// of the *.test.js files that were present when it was fetched. If the
// fingerprint matches on the next run, the fetch is skipped.
type metadataCacheFile struct {
	Fingerprint string    `json:"fingerprint"`
	Meta        *Metadata `json:"meta"`
}

// metaCacheKey combines db and suitePath so that different suites (which load
// different asset bundles) never share the same cache file.
func metaCacheKey(db, suitePath string) string {
	return sanitizeFilename(db + suitePath)
}

// LoadMetaCache reads a previously saved metadata cache for db+suitePath.
// Returns nil, nil if the file is missing or corrupt.
func LoadMetaCache(cacheDir, db, suitePath string) (*metadataCacheFile, error) {
	path := filepath.Join(cacheDir, metaCacheKey(db, suitePath)+".meta.json")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var c metadataCacheFile
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, nil // corrupt → treat as miss
	}
	return &c, nil
}

// SaveMetaCache writes meta to cacheDir/<db+suitePath>.meta.json with the given fingerprint.
func SaveMetaCache(cacheDir, db, suitePath, fingerprint string, meta *Metadata) error {
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return fmt.Errorf("create cache dir: %w", err)
	}
	data, err := json.Marshal(metadataCacheFile{Fingerprint: fingerprint, Meta: meta})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(cacheDir, metaCacheKey(db, suitePath)+".meta.json"), data, 0644)
}

// FingerprintDirs walks roots for *.test.js files and returns a hex string
// that changes whenever any file is added, removed, or modified.
func FingerprintDirs(roots []string) (string, error) {
	var h int32
	for _, root := range roots {
		dirs, err := findTestsDirs(root)
		if err != nil {
			return "", fmt.Errorf("fingerprint %s: %w", root, err)
		}
		for _, td := range dirs {
			if err := filepath.WalkDir(td, func(path string, d os.DirEntry, err error) error {
				if err != nil || d.IsDir() || !strings.HasSuffix(path, ".test.js") {
					return err
				}
				info, err := d.Info()
				if err != nil {
					return nil
				}
				for _, b := range []byte(path) {
					h = (h<<5) - h + int32(b)
				}
				mtime := info.ModTime().UnixNano()
				for i := 0; i < 8; i++ {
					h = (h<<5) - h + int32(mtime&0xff)
					mtime >>= 8
				}
				return nil
			}); err != nil {
				return "", err
			}
		}
	}
	return fmt.Sprintf("%08x", uint32(h)), nil
}

// findTestsDirs returns all {addon}/static/tests directories under root.
func findTestsDirs(root string) ([]string, error) {
	var result []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		name := d.Name()
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
