package sheet

import "strconv"

// Column A is a sheet-local address: positional, unstable across edits and
// stored nowhere. Portable identity is the UID, which only roadmaps and
// milestones have, so a number here can never be mistaken for one.
//
// A context is a prefix and never gets a row of its own. Everything inside it —
// milestones and items alike — runs in one dotted sequence, the way a work
// breakdown numbers a zero-duration task like any other. One sequence is also
// what makes a number unambiguous on its own: a dependency cell naming A.3
// names exactly one row, and the Type column says which kind it found.

// contextLabel is the address of the n-th context (0-based): A, B, ... Z, AA,
// AB, ... — bijective base 26, like a spreadsheet column name.
func contextLabel(n int) string {
	var b []byte
	for {
		b = append([]byte{byte('A' + n%26)}, b...)
		n = n/26 - 1
		if n < 0 {
			return string(b)
		}
	}
}

// entityLabel numbers the n-th entity (1-based) of a context: "A.1".
func entityLabel(context string, n int) string {
	return context + "." + strconv.Itoa(n)
}

// childLabel numbers the j-th child (0-based) of an item: "A.3.1". The store
// caps nesting at one level, so there is never a fourth component.
func childLabel(item string, j int) string {
	return item + "." + strconv.Itoa(j+1)
}
