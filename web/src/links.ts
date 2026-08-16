// Extract bare URLs and `[text](url)` links from descriptions.

// A link found in a description, ready to render.
export interface Link {
  url: string;
  // Explicit Markdown text or a non-empty label derived from the URL.
  label: string;
  // Used by compact affordances that distinguish authored text from fallback.
  explicit: boolean;
}

// Append a URL as its own final paragraph without rewriting any authored text.
// Descriptions are plain text/Markdown, so two line breaks are the smallest
// separator that stays a separate paragraph in both representations.
export function appendLinkToDescription(description: string, url: string): string {
  if (description === "") return url;
  const separator = description.endsWith("\n\n") ? "" : description.endsWith("\n") ? "\n" : "\n\n";
  return `${description}${separator}${url}`;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

// Strip sentence punctuation while preserving balanced URL parentheses.
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

// Match Markdown first so its target is not emitted again as a bare URL.
// Labels are single-line; targets allow one nested parenthesis pair.
// The http(s) prefix is load-bearing: it is what keeps javascript:/data:
// targets from ever reaching an href.
const LINK_RE = /\[([^\]\n]*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|https?:\/\/[^\s]+/g;

// Return distinct HTTP(S) links in first-occurrence order. An explicit label
// replaces a derived one for the same URL without changing that order.
export function extractLinks(text: string): Link[] {
  const byUrl = new Map<string, Link>();
  for (const m of text.matchAll(LINK_RE)) {
    // Markdown targets are group 2; bare URLs need punctuation trimming.
    const url = m[2] ?? trimUrl(m[0]);
    const written = m[1]?.trim();
    const link: Link = written
      ? { url, label: written, explicit: true }
      : { url, label: linkLabel(url), explicit: false };
    const seen = byUrl.get(url);
    // Updating an existing Map key preserves its insertion position.
    if (!seen || (link.explicit && !seen.explicit)) byUrl.set(url, link);
  }
  return [...byUrl.values()];
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
