package hoot

import "fmt"

// Hash computes hoot's generateHash for a test's fullName.
// fullName is the "/" joined path of suite and test names,
// e.g. "Discuss/Thread/can post message".
//
// JS reference (hoot_utils.js):
//
//	hash = (hash << 5) - hash + charCodeAt(i); hash |= 0;
//	return (hash + 16**8).toString(16).slice(-8)
func Hash(fullName string) string {
	var h int32
	for i := 0; i < len(fullName); i++ {
		h = (h<<5)-h + int32(fullName[i])
	}
	return fmt.Sprintf("%08x", uint32(h))
}

// TestRef identifies a single test by either its 8-char hex hash ID or its
// full "/" joined name. Both forms are accepted by --test-id.
type TestRef struct {
	id   string // 8-char hex, always set
	name string // non-empty only when input was a name, not a hash
}

// ParseTestRef parses a --test-id value. An 8-char lowercase/uppercase hex
// string is treated as a raw hash; anything else is treated as a full name
// and hashed on the spot.
func ParseTestRef(s string) TestRef {
	if isHexID(s) {
		return TestRef{id: s}
	}
	return TestRef{id: Hash(s), name: s}
}

// ID returns the 8-char hex hash ready to use in URLs and metadata lookups.
func (r TestRef) ID() string { return r.id }

// IsName reports whether the ref was given as a name rather than a raw hash.
func (r TestRef) IsName() bool { return r.name != "" }

// String returns the original input (name if given as name, hash otherwise).
func (r TestRef) String() string {
	if r.name != "" {
		return r.name
	}
	return r.id
}

// isHexID returns true for exactly 8 hex characters.
func isHexID(s string) bool {
	if len(s) != 8 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}
