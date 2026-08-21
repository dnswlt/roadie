import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseUrl, slugify, writeParams, type UrlState } from "./url";

test("parseUrl reads roadmap, view and item selection", () => {
  assert.deepEqual(parseUrl("?roadmap=3&view=wbs&item=42"), {
    roadmapId: 3,
    view: "wbs",
    selection: { kind: "item", id: 42 },
  });
});

test("parseUrl reads milestone selection", () => {
  assert.deepEqual(parseUrl("?roadmap=1&milestone=7"), {
    roadmapId: 1,
    view: null,
    selection: { kind: "milestone", id: 7 },
  });
});

test("parseUrl reports an absent view as null, so the caller owns the default", () => {
  assert.equal(parseUrl("?roadmap=5").view, null);
  assert.equal(parseUrl("?roadmap=5&view=timeline").view, "timeline");
  assert.equal(parseUrl("?roadmap=5&view=recon").view, "recon");
  assert.equal(parseUrl("?roadmap=5&view=gantt").view, null);
});

test("parseUrl treats a missing/zero/non-numeric roadmap as null", () => {
  assert.equal(parseUrl("").roadmapId, null);
  assert.equal(parseUrl("?roadmap=0").roadmapId, null);
  assert.equal(parseUrl("?roadmap=abc").roadmapId, null);
});

test("parseUrl rejects a malformed selection rather than guessing", () => {
  assert.equal(parseUrl("?roadmap=1&item=abc").selection, null);
  assert.equal(parseUrl("?roadmap=1&item=0").selection, null);
  assert.equal(parseUrl("?roadmap=1&item=-2").selection, null);
  assert.equal(parseUrl("?roadmap=1&item=").selection, null);
});

// Only a hand-edited URL names both kinds; parseUrl still has to be total.
test("item wins when a URL names both kinds", () => {
  assert.deepEqual(parseUrl("?roadmap=1&item=42&milestone=7").selection, {
    kind: "item",
    id: 42,
  });
});

test("parseUrl ignores the decorative name param", () => {
  assert.deepEqual(parseUrl("?roadmap=3&name=q3-plan"), {
    roadmapId: 3,
    view: null,
    selection: null,
  });
});

// Writes into a fresh query, which is what an ordinary session does: the param
// order below is the order a shared link actually carries.
function write(s: UrlState): string {
  const params = new URLSearchParams();
  writeParams(params, s);
  return params.toString();
}

test("writeParams names the roadmap, its slug, and the selection", () => {
  assert.equal(
    write({ roadmap: { id: 3, name: "Q3 Plan" }, view: "wbs", selection: { kind: "item", id: 42 } }),
    "roadmap=3&name=q3-plan&view=wbs&item=42",
  );
});

// Timeline is the default, expressed by absence so the everyday link is short.
test("writeParams leaves the default view out", () => {
  assert.equal(
    write({ roadmap: { id: 3, name: "Q3" }, view: "timeline", selection: null }),
    "roadmap=3&name=q3",
  );
});

test("writeParams omits an unusable slug rather than writing an empty one", () => {
  assert.equal(write({ roadmap: { id: 4, name: "日本語" }, view: "timeline", selection: null }), "roadmap=4");
});

// The writer overwrites a live address bar, so what the previous state left
// behind has to go — including a selection of the other kind. Asserted through
// parseUrl, since set() keeps a pre-existing key in its original position and
// that ordering is incidental.
test("writeParams clears what no longer applies", () => {
  const params = new URLSearchParams("roadmap=9&name=old&view=recon&item=99&milestone=98");
  writeParams(params, {
    roadmap: { id: 1, name: "R" },
    view: "timeline",
    selection: { kind: "milestone", id: 7 },
  });
  assert.deepEqual(parseUrl("?" + params.toString()), {
    roadmapId: 1,
    view: null,
    selection: { kind: "milestone", id: 7 },
  });

  writeParams(params, { roadmap: null, view: "timeline", selection: null });
  assert.equal(params.toString(), "");
});

// parseUrl(write(x)) === x for everything the URL is meant to carry.
test("write and parse round-trip", () => {
  for (const s of [
    { roadmap: { id: 3, name: "Q3 Plan" }, view: "wbs", selection: { kind: "item", id: 42 } },
    { roadmap: { id: 9, name: "Ops" }, view: "recon", selection: { kind: "milestone", id: 1 } },
    { roadmap: { id: 1, name: "X" }, view: "timeline", selection: null },
  ] satisfies UrlState[]) {
    const parsed = parseUrl("?" + write(s));
    assert.equal(parsed.roadmapId, s.roadmap?.id ?? null);
    assert.equal(parsed.view ?? "timeline", s.view);
    assert.deepEqual(parsed.selection, s.selection);
  }
});

test("slugify makes a readable ASCII slug", () => {
  assert.equal(slugify("Q3 Product Roadmap"), "q3-product-roadmap");
  assert.equal(slugify("  Spaces & Symbols!! "), "spaces-symbols");
  assert.equal(slugify("already-a-slug"), "already-a-slug");
});

test("slugify returns empty when nothing usable survives", () => {
  assert.equal(slugify("日本語"), "");
  assert.equal(slugify("---"), "");
});

test("slugify caps length without a trailing hyphen", () => {
  const slug = slugify("a".repeat(40) + " " + "b".repeat(40));
  assert.ok(slug.length <= 60);
  assert.ok(!slug.endsWith("-"));
});
