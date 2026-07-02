package hoot

// TestRef identifies a single test by either its 8-char hex hash ID (as
// computed and reported by hoot itself in the metadata) or its full "/"
// joined name. Both forms are accepted by --test-id.
type TestRef struct {
	id   string // 8-char hex, set only when input was already an ID
	name string // non-empty only when input was a name, not an ID
}

// ParseTestRef parses a --test-id value. An 8-char lowercase/uppercase hex
// string is treated as a raw ID; anything else is treated as a full name to
// be resolved against metadata.
func ParseTestRef(input string) TestRef {
	if isHexID(input) {
		return TestRef{id: input}
	}
	return TestRef{name: input}
}

// ID returns the 8-char hex hash ready to use in URLs and metadata lookups.
func (ref TestRef) ID() string { return ref.id }

// IsName reports whether the ref was given as a name rather than a raw hash.
func (ref TestRef) IsName() bool { return ref.name != "" }

// String returns the original input (name if given as name, hash otherwise).
func (ref TestRef) String() string {
	if ref.name != "" {
		return ref.name
	}
	return ref.id
}

// isHexID returns true for exactly 8 hex characters.
func isHexID(hexStr string) bool {
	if len(hexStr) != 8 {
		return false
	}
	for i := 0; i < len(hexStr); i++ {
		char := hexStr[i]
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return false
		}
	}
	return true
}
