package sheet

import "testing"

func TestExtractLinks(t *testing.T) {
	for _, tc := range []struct {
		name string
		text string
		want []link
	}{{
		name: "markdown label wins over the bare URL for the same target",
		text: "see [the design](https://x.test/design) and again https://x.test/design",
		want: []link{{url: "https://x.test/design", label: "the design", explicit: true}},
	}, {
		name: "a Markdown target is not re-emitted as a bare URL",
		text: "[docs](https://x.test/a)",
		want: []link{{url: "https://x.test/a", label: "docs", explicit: true}},
	}, {
		name: "sentence punctuation is not part of a bare URL",
		text: "read https://x.test/a, then https://x.test/b.",
		want: []link{
			{url: "https://x.test/a", label: "x.test/a"},
			{url: "https://x.test/b", label: "x.test/b"},
		},
	}, {
		name: "a URL keeps the parentheses it balances",
		text: "https://x.test/wiki/Foo_(bar) done",
		want: []link{{url: "https://x.test/wiki/Foo_(bar)", label: "x.test/Foo_(bar)"}},
	}, {
		name: "duplicates collapse, keeping first-occurrence order",
		text: "https://x.test/b https://x.test/a https://x.test/b",
		want: []link{
			{url: "https://x.test/b", label: "x.test/b"},
			{url: "https://x.test/a", label: "x.test/a"},
		},
	}, {
		name: "a later label upgrades an earlier bare URL in place",
		text: "https://x.test/a then https://x.test/b then [A](https://x.test/a)",
		want: []link{
			{url: "https://x.test/a", label: "A", explicit: true},
			{url: "https://x.test/b", label: "x.test/b"},
		},
	}, {
		name: "only http(s) targets are links",
		text: "mailto:a@b.test javascript:alert(1) ftp://x.test/f",
		want: nil,
	}, {
		name: "an empty Markdown label falls back to the URL",
		text: "[](https://x.test/a)",
		want: []link{{url: "https://x.test/a", label: "x.test/a"}},
	}} {
		t.Run(tc.name, func(t *testing.T) {
			got := extractLinks(tc.text)
			if len(got) != len(tc.want) {
				t.Fatalf("links = %+v, want %+v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("link %d = %+v, want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}

// The same cases links.test.ts pins for linkLabel: a workbook has to name an
// issue the way the app does, or the two disagree about the same description.
func TestLinkLabel(t *testing.T) {
	for _, tc := range []struct{ url, want string }{
		{"https://jira.co/browse/ABC-123", "ABC-123"},
		{"https://jira.co/browse/PROJ2-9/details", "PROJ2-9"},
		{"https://github.com/a/one", "github.com/one"},
		{"https://github.com/a/two", "github.com/two"},
		{"https://example.com", "example.com"},
		{"https://example.com/", "example.com"},
		// The shape decides, whatever host it is on.
		{"http://localhost:4012/browse/PAY-101", "PAY-101"},
		// The generic label follows URL.hostname: no port, and lowercased.
		{"http://localhost:4012/wiki/Page", "localhost/Page"},
		{"https://JIRA.acme.com/wiki/Page", "jira.acme.com/Page"},
		{"not a url", "not a url"},
	} {
		if got := linkLabel(tc.url); got != tc.want {
			t.Errorf("linkLabel(%q) = %q, want %q", tc.url, got, tc.want)
		}
	}
}
