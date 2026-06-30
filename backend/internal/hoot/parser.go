package hoot

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	reFailure   = regexp.MustCompile(`(?s)\[HOOT\][^\n]*Test "(.+?)" failed:(.*)`)
	reDone      = regexp.MustCompile(`\[HOOT\] (Passed|Failed) (\d+) tests`)
	rePassed    = regexp.MustCompile(`\((\d+) passed`)
	reColor     = regexp.MustCompile(`\s*color:[^;]+;[^\n]*`)
	reRunning   = regexp.MustCompile(`\[HOOT\] Running test "(.+)"`)
	reSuiteDone = regexp.MustCompile(`\[HOOT\] "(.+)" ended\s+\(passed:\s*(\d+)(?:\s*/\s*failed:\s*(\d+))?\s*/?\s*time:\s*(\d+)\s*ms\)`)
)

type DoneResult struct {
	Passed int
	Failed int
}

// ParseFailure extracts a test name and stack trace from a [HOOT] failure console line.
func ParseFailure(text string) (name, stack string, ok bool) {
	m := reFailure.FindStringSubmatch(text)
	if m == nil {
		return "", "", false
	}
	name = m[1]
	stack = strings.TrimSpace(reColor.ReplaceAllString(m[2], ""))
	return name, stack, true
}

// ParseRunning extracts the test name from a [HOOT] Running test "..." console line.
func ParseRunning(text string) (name string, ok bool) {
	m := reRunning.FindStringSubmatch(text)
	if m == nil {
		return "", false
	}
	return m[1], true
}

// SuiteDoneResult holds the counts from a [HOOT] "suite" ended (...) line.
type SuiteDoneResult struct {
	Suite  string
	Passed int
	Failed int
	Ms     int
}

// ParseSuiteDone parses a [HOOT] "suite" ended (passed: N / failed: N / time: X ms) line.
// failed is 0 when the field is absent (all tests passed).
func ParseSuiteDone(text string) (SuiteDoneResult, bool) {
	m := reSuiteDone.FindStringSubmatch(text)
	if m == nil {
		return SuiteDoneResult{}, false
	}
	passed, _ := strconv.Atoi(m[2])
	failed := 0
	if m[3] != "" {
		failed, _ = strconv.Atoi(m[3])
	}
	ms, _ := strconv.Atoi(m[4])
	return SuiteDoneResult{Suite: m[1], Passed: passed, Failed: failed, Ms: ms}, true
}

// ParseDone detects the Hoot completion summary line and returns pass/fail counts.
func ParseDone(text string) (DoneResult, bool) {
	m := reDone.FindStringSubmatch(text)
	if m == nil {
		return DoneResult{}, false
	}
	n, _ := strconv.Atoi(m[2])
	if m[1] == "Passed" {
		return DoneResult{Passed: n}, true
	}
	// "Failed N tests (M passed, total time: …)"
	passed := 0
	if mp := rePassed.FindStringSubmatch(text); mp != nil {
		passed, _ = strconv.Atoi(mp[1])
	}
	return DoneResult{Failed: n, Passed: passed}, true
}
