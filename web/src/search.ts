// Find-in-roadmap: turning a typed query into a ranked list of items and
// milestones. DOM-free so it can be unit-tested (search.test.ts); the popup
// that renders the results lives in app.ts.
//
// It searches `state.current`, never the rendered chart, and that is the whole
// point. The chart deliberately omits hidden lanes (render.ts) and the children
// of collapsed parents (layout.ts), and it never renders descriptions or labels
// as text at all — so the browser's own find-in-page cannot see any of them.
// The things you lean on hardest once a roadmap gets big are exactly the things
// that make Ctrl+F quietly answer "no results" about an item that exists.

import type { Item, Milestone, RoadmapFull } from "./types";

// Which field a term matched on. Shown as a tag on the result row for anything
// but the title, so a hit whose reason is invisible on the chart explains
// itself instead of looking like a bug.
export type MatchField = "title" | "label" | "description" | "context";

// Match tiers, best first. A *term's* tier is the best it reaches on any field;
// a *row's* tier is the worst over all its terms (see rowTier).
const T_PREFIX = 0; // title starts with the term
const T_WORD = 1; // term starts a word in the title
const T_SUB = 2; // term appears mid-word in the title
const T_LABEL = 3;
const T_DESC = 4;
const T_LANE = 5;

const FIELD_OF: MatchField[] = ["title", "title", "title", "label", "description", "context"];

export interface Match {
  kind: "item" | "milestone";
  id: number;
  title: string;
  laneId: number;
  laneName: string;
  laneColor: string;
  startDate: string;
  endDate: string; // equal to startDate for milestones, which have no duration
  field: MatchField;
}

// parseQuery splits the raw input into lowercased terms. Whitespace-separated
// and order-independent (see rowTier) rather than one literal substring: the
// common way to find "Migrate auth provider" is to type "auth migr", which a
// raw-input substring match can never satisfy.
export function parseQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWordStart(hay: string, i: number): boolean {
  return i === 0 || !WORD_CHAR.test(hay[i - 1]!);
}

// titleTier scores a term against a title, taking the best of *all* its
// occurrences: in "reauthorize auth flow" the term "auth" starts a word later
// on, and ranking it on the buried first hit would bury the row.
function titleTier(term: string, title: string): number | null {
  let best: number | null = null;
  for (let i = title.indexOf(term); i >= 0; i = title.indexOf(term, i + 1)) {
    const tier = i === 0 ? T_PREFIX : isWordStart(title, i) ? T_WORD : T_SUB;
    if (best === null || tier < best) best = tier;
    if (best === T_PREFIX) break;
  }
  return best;
}

// The lowercased text of one row, by field.
interface Haystack {
  title: string;
  labels: string;
  description: string;
  lane: string;
}

function termTier(term: string, h: Haystack): number | null {
  const t = titleTier(term, h.title);
  if (t !== null) return t;
  if (h.labels.includes(term)) return T_LABEL;
  if (h.description.includes(term)) return T_DESC;
  if (h.lane.includes(term)) return T_LANE;
  return null;
}

// rowTier ANDs the terms: one miss rejects the row, and the row is ranked by
// its *weakest* term. That keeps "both words in the title" above "one in the
// title, one buried in a description", which a summed score would not.
function rowTier(terms: string[], h: Haystack): number | null {
  let worst = T_PREFIX;
  for (const term of terms) {
    const tier = termTier(term, h);
    if (tier === null) return null;
    if (tier > worst) worst = tier;
  }
  return worst;
}

interface Scored {
  m: Match;
  tier: number;
}

// search returns every match in the roadmap, best first — every one, not a
// page: the caller caps the *list* it draws, but the count it reports has to be
// the truth. Ties break by date, then title, so the order is stable and
// explicable rather than clever.
export function search(rm: RoadmapFull, query: string): Match[] {
  const terms = parseQuery(query);
  if (terms.length === 0) return [];
  const scored: Scored[] = [];

  for (const lane of rm.lanes) {
    const laneLower = lane.name.toLowerCase();
    const base = { laneId: lane.id, laneName: lane.name, laneColor: lane.color };

    const considerItem = (it: Item): void => {
      const tier = rowTier(terms, {
        title: it.title.toLowerCase(),
        labels: it.labels.join("\n").toLowerCase(),
        description: it.description.toLowerCase(),
        lane: laneLower,
      });
      if (tier === null) return;
      scored.push({
        tier,
        m: {
          kind: "item",
          id: it.id,
          title: it.title,
          startDate: it.startDate,
          endDate: it.endDate,
          field: FIELD_OF[tier]!,
          ...base,
        },
      });
    };

    for (const item of lane.items) {
      considerItem(item);
      // Children are searched even when their parent is folded away — being
      // unreachable on the chart is a reason to find them here, not a reason
      // to skip them.
      for (const child of item.children) considerItem(child);
    }

    for (const ms of lane.milestones as Milestone[]) {
      const tier = rowTier(terms, {
        title: ms.title.toLowerCase(),
        labels: "", // milestones carry neither labels nor a flag
        description: ms.description.toLowerCase(),
        lane: laneLower,
      });
      if (tier === null) continue;
      scored.push({
        tier,
        m: {
          kind: "milestone",
          id: ms.id,
          title: ms.title,
          startDate: ms.date,
          endDate: ms.date,
          field: FIELD_OF[tier]!,
          ...base,
        },
      });
    }
  }

  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.m.startDate.localeCompare(b.m.startDate) ||
      a.m.title.localeCompare(b.m.title) ||
      a.m.id - b.m.id,
  );
  return scored.map((s) => s.m);
}
