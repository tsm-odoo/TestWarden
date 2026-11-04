// Test references: a test is given either by its hex hash ID or by its full name.

package hoot

// TestRef identifies a single test by its 8-char hex hash ID (as reported by Hoot in the
// metadata) or by its name, a substring of the full "/" joined name.
type TestRef struct {
	id   string
	name string
}

// ParseTestRef treats an 8-char hex string as an ID and anything else as a name.
func ParseTestRef(input string) TestRef {
	if isHexID(input) {
		return TestRef{id: input}
	}
	return TestRef{name: input}
}

func (ref TestRef) ID() string { return ref.id }

func (ref TestRef) IsName() bool { return ref.name != "" }

func (ref TestRef) String() string {
	if ref.name != "" {
		return ref.name
	}
	return ref.id
}

func isHexID(hexStr string) bool {
	if len(hexStr) != 8 {
		return false
	}
	for _, char := range hexStr {
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f' || char >= 'A' && char <= 'F') {
			return false
		}
	}
	return true
}
