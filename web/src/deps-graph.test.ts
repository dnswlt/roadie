import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dateConflict, linkedRefs, refKey, sameRef, splitDeps } from "./deps-graph";
import type { Dependency, DependencyRef } from "./types";

const item = (id: number): DependencyRef => ({ kind: "item", id });
const ms = (id: number): DependencyRef => ({ kind: "milestone", id });

let nextId = 1;
const edge = (from: DependencyRef, to: DependencyRef): Dependency => ({ id: nextId++, from, to });

test("sameRef distinguishes kinds sharing an id", () => {
  assert.ok(sameRef(item(1), item(1)));
  assert.ok(!sameRef(item(1), ms(1)));
  assert.ok(!sameRef(item(1), item(2)));
});

test("refKey is kind-qualified", () => {
  assert.notEqual(refKey(item(1)), refKey(ms(1)));
});

test("splitDeps separates directions around one entity", () => {
  // a → b → M; c → b. Seen from b: depends on a and c, needed by M.
  const deps = [edge(item(1), item(2)), edge(item(2), ms(1)), edge(item(3), item(2))];
  const { dependsOn, neededBy } = splitDeps(deps, item(2));
  assert.deepEqual(
    dependsOn.map((d) => refKey(d.from)),
    ["item:1", "item:3"],
  );
  assert.deepEqual(
    neededBy.map((d) => refKey(d.to)),
    ["milestone:1"],
  );
  // An uninvolved entity sees nothing.
  const empty = splitDeps(deps, item(9));
  assert.equal(empty.dependsOn.length + empty.neededBy.length, 0);
});

test("linkedRefs collects both directions", () => {
  const deps = [edge(item(1), item(2)), edge(item(2), ms(1))];
  assert.deepEqual([...linkedRefs(deps, item(2))].sort(), ["item:1", "milestone:1"]);
});

test("dateConflict flags only a strict overlap", () => {
  assert.ok(dateConflict("2026-02-01", "2026-01-15")); // prerequisite ends after start
  assert.ok(!dateConflict("2026-01-15", "2026-01-15")); // same-day handover is fine
  assert.ok(!dateConflict("2026-01-10", "2026-01-15"));
});
