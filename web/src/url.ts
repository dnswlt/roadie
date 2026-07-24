// URL <-> view mapping.
//
// The address bar continuously reflects only the *open roadmap*
// (`?roadmap=<id>`) — low-churn, high-value state that's worth keeping live for
// reload/bookmark/share. Item and milestone *selection* is deliberately NOT
// mirrored on every click: instead a deep link is produced on demand (the edit
// panel's copy-link button, `selectionLink`) and consumed once at boot
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

// setRoadmapUrl reflects the open roadmap (or its absence) in the address bar
// and drops any lingering selection hash.
export function setRoadmapUrl(roadmapId: number | null): void {
  const url = new URL(window.location.href);
  if (roadmapId !== null) url.searchParams.set("roadmap", String(roadmapId));
  else url.searchParams.delete("roadmap");
  url.hash = "";
  if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
}

// selectionLink builds a shareable absolute URL for a selection in the current
// roadmap, e.g. https://host/?roadmap=3#item-42.
export function selectionLink(roadmapId: number, kind: "item" | "milestone", id: number): string {
  const url = new URL(window.location.href);
  url.searchParams.set("roadmap", String(roadmapId));
  url.hash = `${kind}-${id}`;
  return url.href;
}
