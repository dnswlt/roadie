// URL <-> view mapping.
//
// The address bar continuously reflects only the *open roadmap*
// (`?roadmap=<id>`, plus a decorative `&name=<slug>` for human readability) —
// low-churn, high-value state that's worth keeping live for reload/bookmark/
// share. The numeric id is the sole identity; `name` is never read back.
// Item and milestone *selection* is deliberately NOT mirrored on every click:
// instead a deep link is produced on demand (the edit panel's copy-link
// button, `selectionLink`) and consumed once at boot
// (`readUrl` + applySelection in app.ts). All writes use replaceState so
// navigating inside the app never grows the browser history.

export interface UrlTarget {
  roadmapId: number | null;
  selection: { kind: "item" | "milestone"; id: number } | null;
}

// parseUrl turns a query string + hash into a target. Pure, so it's unit
// testable; readUrl wraps it around window.location.
export function parseUrl(search: string, hash: string): UrlTarget {
  const roadmap = Number(new URLSearchParams(search).get("roadmap"));
  const m = /^#(item|milestone)-(\d+)$/.exec(hash);
  return {
    roadmapId: Number.isInteger(roadmap) && roadmap > 0 ? roadmap : null,
    selection: m ? { kind: m[1] as "item" | "milestone", id: Number(m[2]) } : null,
  };
}

// readUrl parses the current address. Call it once at boot, before anything
// rewrites the address bar.
export function readUrl(): UrlTarget {
  return parseUrl(window.location.search, window.location.hash);
}

// slugify turns a roadmap name into a short, ASCII, hyphenated slug for the
// decorative `name` param. Returns "" when nothing usable survives (e.g. a
// purely non-latin name), in which case the param is omitted.
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

// writeRoadmapParams sets (or clears) the authoritative `roadmap` id plus the
// decorative `name` slug on a URLSearchParams. The slug is purely for human
// readability — parseUrl never reads it.
function writeRoadmapParams(params: URLSearchParams, roadmap: { id: number; name: string } | null): void {
  if (roadmap === null) {
    params.delete("roadmap");
    params.delete("name");
    return;
  }
  params.set("roadmap", String(roadmap.id));
  const slug = slugify(roadmap.name);
  if (slug) params.set("name", slug);
  else params.delete("name");
}

// setRoadmapUrl reflects the open roadmap (or its absence) in the address bar
// and drops any lingering selection hash.
export function setRoadmapUrl(roadmap: { id: number; name: string } | null): void {
  const url = new URL(window.location.href);
  writeRoadmapParams(url.searchParams, roadmap);
  url.hash = "";
  if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
}

// selectionLink builds a shareable absolute URL for a selection in the given
// roadmap, e.g. https://host/?roadmap=3&name=q3-plan#item-42.
export function selectionLink(roadmap: { id: number; name: string }, kind: "item" | "milestone", id: number): string {
  const url = new URL(window.location.href);
  writeRoadmapParams(url.searchParams, roadmap);
  url.hash = `${kind}-${id}`;
  return url.href;
}
