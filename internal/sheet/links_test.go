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
			{url: "https://x.test/a", label: "https://x.test/a"},
			{url: "https://x.test/b", label: "https://x.test/b"},
		},
	}, {
		name: "a URL keeps the parentheses it balances",
		text: "https://x.test/wiki/Foo_(bar) done",
		want: []link{{url: "https://x.test/wiki/Foo_(bar)", label: "https://x.test/wiki/Foo_(bar)"}},
	}, {
		name: "duplicates collapse, keeping first-occurrence order",
		text: "https://x.test/b https://x.test/a https://x.test/b",
		want: []link{
			{url: "https://x.test/b", label: "https://x.test/b"},
			{url: "https://x.test/a", label: "https://x.test/a"},
		},
	}, {
		name: "a later label upgrades an earlier bare URL in place",
		text: "https://x.test/a then https://x.test/b then [A](https://x.test/a)",
		want: []link{
			{url: "https://x.test/a", label: "A", explicit: true},
			{url: "https://x.test/b", label: "https://x.test/b"},
		},
	}, {
		name: "only http(s) targets are links",
		text: "mailto:a@b.test javascript:alert(1) ftp://x.test/f",
		want: nil,
	}, {
		name: "an empty Markdown label falls back to the URL",
		text: "[](https://x.test/a)",
		want: []link{{url: "https://x.test/a", label: "https://x.test/a"}},
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
