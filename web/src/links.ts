// URL extraction for the description fields. Pure string logic (no DOM) so it
// can be unit-tested; the panel turns the results into clickable chips.

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

// trimUrl strips trailing punctuation the URL regex greedily swallowed, so a
// URL written mid-sentence ("see https://x/y.") or in parens ("(https://x/y)")
// yields a clean link. A trailing ")" is kept only when the URL's own parens
// are balanced, so wiki links like .../Foo_(bar) survive.
export function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (!")].,;!?'\"".includes(ch)) break;
    if (ch === ")" && countChar(url.slice(0, end), "(") >= countChar(url.slice(0, end), ")")) break;
    end--;
  }
  return url.slice(0, end);
}

// extractUrls returns the distinct http(s) URLs found in text, cleaned of
// trailing punctuation.
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s]+/g) ?? [];
  return [...new Set(matches.map(trimUrl))];
}

// linkLabel gives a chip a short, human-readable name: a Jira-style issue key
// when the URL is a ".../browse/KEY-123" link, otherwise the host plus the
// last path segment (so two links to the same host stay distinguishable).
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    const jira = u.pathname.match(/\/browse\/([A-Z0-9]+-\d+)/);
    if (jira) return jira[1]!;
    const segments = u.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    return last ? `${u.hostname}/${last}` : u.hostname;
  } catch {
    return url;
  }
}
