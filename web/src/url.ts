// URL <-> view mapping.
//
// The address bar is the shareable link. It carries the open roadmap, the view
// it is being read in, and the one selected item or milestone — continuously,
// so copying the location bar is all sharing takes. Zoom and scroll position
// stay out: `pxPerDay` is a pixel scale, which frames a different span of time
// on someone else's screen, and neither is worth the churn of writing on every
// wheel tick. Filter, hidden lanes and folds stay out too — the recipient reads
// the roadmap through their own settings.
//
// Selection is a query param rather than a fragment. The app reads the URL once,
// at boot, and editing a fragment by hand does not reload the page: `#item-43`
// would leave the address bar disagreeing with what is on screen, where
// `item=43` reloads into it. Fragments are not used at all, so any found in an
// incoming link is dropped rather than carried into everything copied after.
//
// All writes use replaceState, so navigating inside the app never grows the
// browser history.

export type UrlView = "timeline" | "wbs" | "recon";

export interface UrlSelection {
  kind: "item" | "milestone";
  id: number;
}

export interface UrlTarget {
  roadmapId: number | null;
  view: UrlView | null;
  selection: UrlSelection | null;
}

// The state the address bar mirrors. `view` is always concrete; the writer is
// what decides that the default is expressed by leaving the param out.
export interface UrlState {
  roadmap: { id: number; name: string } | null;
  view: UrlView;
  selection: UrlSelection | null;
}

function posInt(raw: string | null): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// parseUrl turns a query string into a target. Pure, so it's unit testable;
// readUrl wraps it around window.location.
export function parseUrl(search: string): UrlTarget {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  const item = posInt(params.get("item"));
  const milestone = posInt(params.get("milestone"));
  // Only a hand-edited URL can name both kinds; item wins, so every URL maps to
  // exactly one target rather than to an error the caller has to handle.
  const selection: UrlSelection | null =
    item !== null
      ? { kind: "item", id: item }
      : milestone !== null
        ? { kind: "milestone", id: milestone }
        : null;
  return {
    roadmapId: posInt(params.get("roadmap")),
    view: view === "timeline" || view === "wbs" || view === "recon" ? view : null,
    selection,
  };
}

// readUrl parses the current address. Call it once at boot, before anything
// rewrites the address bar.
export function readUrl(): UrlTarget {
  return parseUrl(window.location.search);
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

// writeParams applies a UrlState to a URLSearchParams. Split out from syncUrl
// so the mapping is testable without a browser.
export function writeParams(params: URLSearchParams, s: UrlState): void {
  if (s.roadmap === null) {
    params.delete("roadmap");
    params.delete("name");
  } else {
    params.set("roadmap", String(s.roadmap.id));
    // Purely for human readability — parseUrl never reads it back.
    const slug = slugify(s.roadmap.name);
    if (slug) params.set("name", slug);
    else params.delete("name");
  }
  // Timeline is the default, so it is expressed by absence: the everyday link
  // stays short, and only a deliberately different view says so.
  if (s.view === "timeline") params.delete("view");
  else params.set("view", s.view);
  params.delete("item");
  params.delete("milestone");
  if (s.selection) params.set(s.selection.kind, String(s.selection.id));
}

// syncUrl reflects the current view state in the address bar. The single writer:
// every path that changes what the URL should say goes through here, so the two
// can never drift apart in the way two writers would.
export function syncUrl(s: UrlState): void {
  const url = new URL(window.location.href);
  writeParams(url.searchParams, s);
  url.hash = ""; // fragments are not part of the mapping (see above)
  if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
}
