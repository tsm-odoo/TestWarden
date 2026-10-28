package hoot

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/go-rod/rod/lib/proto"
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

// Hoot's own wording (see expect.js) when a test was cut short by runner.stop() rather than
// actually failing on its own -- e.g. a sibling worker stopping this page early. Not a real
// failure: the message says as much ("results may not be relevant").
const abortedMarker = "test was aborted, results may not be relevant"

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

// IsAbortedFailure reports whether a ParseFailure stack is just noise from the test being cut
// short (e.g. a sibling worker's stopHootRunner call) rather than an actual assertion failure.
func IsAbortedFailure(stack string) bool {
	return strings.Contains(stack, abortedMarker)
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

// Joins a console call's arguments into a single string, skipping the CSS
// arguments that accompany Hoot's styled "%c[HOOT]%c msg" logs.
func ArgsToText(args []*proto.RuntimeRemoteObject) string {
	return joinArgs(args, func(arg *proto.RuntimeRemoteObject) string { return arg.Description })
}

// Like ArgsToText, but objects and arrays are rendered from their preview ({a: 1, b: "x"})
// instead of their bare class name ("Object"). Meant for output read by humans only: Hoot's
// own lines are matched against ArgsToText.
func ArgsToPreviewText(args []*proto.RuntimeRemoteObject) string {
	return joinArgs(args, func(arg *proto.RuntimeRemoteObject) string {
		if arg.Type == proto.RuntimeRemoteObjectTypeObject && arg.Preview != nil &&
			arg.Subtype != proto.RuntimeRemoteObjectSubtypeError && arg.Subtype != proto.RuntimeRemoteObjectSubtypeNode {
			return previewText(arg.Preview)
		}
		return arg.Description
	})
}

func joinArgs(args []*proto.RuntimeRemoteObject, describe func(*proto.RuntimeRemoteObject) string) string {
	parts := make([]string, 0, len(args))
	for _, arg := range args {
		var str string
		if arg.Type == proto.RuntimeRemoteObjectTypeString {
			str = arg.Value.Str()
		} else if str = describe(arg); str == "" {
			continue
		}
		if strings.HasPrefix(str, "color:") || strings.HasPrefix(str, "background:") || strings.HasPrefix(str, "font-") {
			continue
		}
		parts = append(parts, strings.ReplaceAll(str, "%c", ""))
	}
	return strings.Join(parts, " ")
}

// Renders the preview CDP attaches to an object: only its first few properties, and nested
// objects one level deep, so the output ends in an ellipsis when the object is larger.
func previewText(preview *proto.RuntimeObjectPreview) string {
	if preview == nil {
		return ""
	}
	// Map and set entries are previews of their own, primitives included.
	if preview.Type == proto.RuntimeObjectPreviewTypeString {
		return strconv.Quote(preview.Description)
	}
	if preview.Type != proto.RuntimeObjectPreviewTypeObject {
		return preview.Description
	}
	items := make([]string, 0, len(preview.Properties)+len(preview.Entries)+1)
	isArray := preview.Subtype == proto.RuntimeObjectPreviewSubtypeArray
	for _, prop := range preview.Properties {
		value := prop.Value
		if prop.Type == proto.RuntimePropertyPreviewTypeString {
			value = strconv.Quote(value)
		} else if prop.ValuePreview != nil {
			value = previewText(prop.ValuePreview)
		}
		if isArray {
			items = append(items, value)
		} else {
			items = append(items, prop.Name+": "+value)
		}
	}
	for _, entry := range preview.Entries {
		value := previewText(entry.Value)
		if entry.Key != nil {
			value = previewText(entry.Key) + " => " + value
		}
		items = append(items, value)
	}
	if preview.Overflow {
		items = append(items, "…")
	}
	body := strings.Join(items, ", ")
	switch {
	case isArray:
		return "[" + body + "]"
	case preview.Subtype == proto.RuntimeObjectPreviewSubtypeMap, preview.Subtype == proto.RuntimeObjectPreviewSubtypeSet:
		return preview.Description + " {" + body + "}"
	case preview.Description != "" && preview.Description != "Object":
		return preview.Description + " {" + body + "}"
	}
	return "{" + body + "}"
}
