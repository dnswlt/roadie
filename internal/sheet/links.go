package sheet

import (
	"net/url"
	"regexp"
	"strings"
)

// Descriptions carry links; there is no link field. This is a port of
// web/src/links.ts — Markdown first so its target is not re-emitted as a bare
// URL, and the same shortening for a link that has no text of its own, so a
// workbook names an issue the way the app does.

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
			label, explicit = linkLabel(url), false
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

// Known link shapes, recognised so that a link reads as the thing it points at
// rather than as a URL. The set is open and happens to hold one today; a shape
// is matched on the URL alone.
//
// This is presentation, not tracker integration. Deciding which of a
// description's links are the tracker's own issues is a separate job, needs the
// configured tracker host, and belongs to Recon — see meResponse.TrackerURL.
var issueKeyPath = regexp.MustCompile(`/browse/([A-Z0-9]+-\d+)`)

// linkLabel gives a link a short, readable name: an issue key when the URL is a
// ".../browse/KEY-123" link, otherwise the host plus the last path segment (so
// two links to the same host stay distinguishable).
//
// Parity with links.ts stops at a URL Go's parser rejects and a browser accepts
// — an invalid percent escape in the path. The cell then holds the whole URL
// where the app would shorten it.
func linkLabel(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Hostname() == "" {
		return rawURL
	}
	if m := issueKeyPath.FindStringSubmatch(u.EscapedPath()); m != nil {
		return m[1]
	}
	// Lowercased because URL.hostname is: a host is case-insensitive, and the
	// same link must not read two ways in the app and in the workbook.
	host := strings.ToLower(u.Hostname())
	segments := strings.FieldsFunc(u.EscapedPath(), func(r rune) bool { return r == '/' })
	if len(segments) == 0 {
		return host
	}
	return host + "/" + segments[len(segments)-1]
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
