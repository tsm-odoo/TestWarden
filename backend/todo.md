- when a test is in only, it goes against runner setup. we should log an error and exit,
  both on go and .ts
- Do not show channel when visitor is typing => test not found. should be able to find
  test by name.
- structure rework (already planned).
- some tests requiring focus fail. probably due to multi workers? should find a fix.
- longer names (zr => cryptic => zipReader). There shouldn't be any 1/2 char variables
