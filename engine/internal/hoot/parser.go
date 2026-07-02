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
	matches := reFailure.FindStringSubmatch(text)
	if matches == nil {
		return "", "", false
	}
	name = matches[1]
	stack = strings.TrimSpace(reColor.ReplaceAllString(matches[2], ""))
	return name, stack, true
}

// ParseRunning extracts the test name from a [HOOT] Running test "..." console line.
func ParseRunning(text string) (name string, ok bool) {
	matches := reRunning.FindStringSubmatch(text)
	if matches == nil {
		return "", false
	}
	return matches[1], true
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
	matches := reSuiteDone.FindStringSubmatch(text)
	if matches == nil {
		return SuiteDoneResult{}, false
	}
	passed, _ := strconv.Atoi(matches[2])
	failed := 0
	if matches[3] != "" {
		failed, _ = strconv.Atoi(matches[3])
	}
	ms, _ := strconv.Atoi(matches[4])
	return SuiteDoneResult{Suite: matches[1], Passed: passed, Failed: failed, Ms: ms}, true
}

// ParseDone detects the Hoot completion summary line and returns pass/fail counts.
func ParseDone(text string) (DoneResult, bool) {
	matches := reDone.FindStringSubmatch(text)
	if matches == nil {
		return DoneResult{}, false
	}
	count, _ := strconv.Atoi(matches[2])
	if matches[1] == "Passed" {
		return DoneResult{Passed: count}, true
	}
	// "Failed N tests (M passed, total time: …)"
	passed := 0
	if passedMatches := rePassed.FindStringSubmatch(text); passedMatches != nil {
		passed, _ = strconv.Atoi(passedMatches[1])
	}
	return DoneResult{Failed: count, Passed: passed}, true
}
