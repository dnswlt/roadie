import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseUrl } from "./url";

test("parseUrl reads roadmap id and item selection", () => {
  assert.deepEqual(parseUrl("?roadmap=3", "#item-42"), {
    roadmapId: 3,
    selection: { kind: "item", id: 42 },
  });
});

test("parseUrl reads milestone selection", () => {
  assert.deepEqual(parseUrl("?roadmap=1", "#milestone-7"), {
    roadmapId: 1,
    selection: { kind: "milestone", id: 7 },
  });
});

test("parseUrl tolerates a missing hash", () => {
  assert.deepEqual(parseUrl("?roadmap=5", ""), { roadmapId: 5, selection: null });
});

test("parseUrl treats a missing/zero/non-numeric roadmap as null", () => {
  assert.equal(parseUrl("", "").roadmapId, null);
  assert.equal(parseUrl("?roadmap=0", "").roadmapId, null);
  assert.equal(parseUrl("?roadmap=abc", "").roadmapId, null);
});

test("parseUrl rejects malformed selection hashes", () => {
  assert.equal(parseUrl("?roadmap=1", "#item-abc").selection, null);
  assert.equal(parseUrl("?roadmap=1", "#item-").selection, null);
  assert.equal(parseUrl("?roadmap=1", "#lane-3").selection, null);
  assert.equal(parseUrl("?roadmap=1", "#gantt").selection, null);
});
