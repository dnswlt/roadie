package sheet

import (
	"regexp"
	"strings"
)

// Descriptions carry links; there is no link field. This mirrors the extraction
// in web/src/links.ts — Markdown first so its target is not re-emitted as a bare
// URL — but stops at the label: linkLabel's Jira-shaped shortening needs to know
// which host is the tracker, and that knowledge stays in the tracker packages.
// Here a link is its Markdown text, else the URL itself.

// The http(s) prefix is load-bearing: it is what keeps javascript:/data:
// targets out of a cell's hyperlink. Labels are single-line; targets allow one
// nested parenthesis pair. Go's regexp is leftmost-first, so the Markdown
// alternative wins at the position where both could start.
var linkRE = regexp.MustCompile(`\[([^\]\n]*)\]\((https?://(?:[^\s()]|\([^\s()]*\))+)\)|https?://[^\s]+`)

type link struct {
	url   string
	label string
	// Whether the label was authored rather than derived from the URL.
	explicit bool
}

// extractLinks returns the distinct HTTP(S) links in a description, in
// first-occurrence order. An explicit label replaces a derived one for the same
// URL without moving it.
func extractLinks(text string) []link {
	var order []string
	seen := map[string]link{}
	for _, m := range linkRE.FindAllStringSubmatch(text, -1) {
		url, label, explicit := m[2], m[1], true
		if url == "" { // a bare URL: the whole match, minus sentence punctuation
			url, label, explicit = trimURL(m[0]), "", false
		}
		label = strings.TrimSpace(label)
		if label == "" {
			label, explicit = url, false
		}
		prev, ok := seen[url]
		if !ok {
			order = append(order, url)
		}
		if !ok || (explicit && !prev.explicit) {
			seen[url] = link{url: url, label: label, explicit: explicit}
		}
	}
	links := make([]link, 0, len(order))
	for _, url := range order {
		links = append(links, seen[url])
	}
	return links
}

// trimURL strips sentence punctuation from a bare URL while preserving
// parentheses the URL itself balances.
func trimURL(url string) string {
	end := len(url)
	for end > 0 {
		ch := url[end-1]
		if !isTrailingPunct(ch) {
			break
		}
		if ch == ')' && countByte(url[:end], '(') >= countByte(url[:end], ')') {
			break
		}
		end--
	}
	return url[:end]
}

func isTrailingPunct(ch byte) bool {
	switch ch {
	case ')', ']', '.', ',', ';', '!', '?', '\'', '"':
		return true
	}
	return false
}

func countByte(s string, b byte) int {
	n := 0
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			n++
		}
	}
	return n
}
