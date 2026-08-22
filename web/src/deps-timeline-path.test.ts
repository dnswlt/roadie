import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dependencyPaths, timelineEdgeRefs } from "./deps-timeline-path";
import type { Dependency } from "./types";

test("timeline arrows point from the prerequisite to its dependent", () => {
  const dependency: Dependency = {
    id: 1,
    from: { kind: "item", id: 10 },
    to: { kind: "milestone", id: 20 },
  };
  assert.deepEqual(timelineEdgeRefs(dependency), {
    start: dependency.from,
    target: dependency.to,
  });
});

test("dependencyPaths bends forward and leaves the arrowhead clear", () => {
  assert.deepEqual(dependencyPaths({ x: 10, y: 20 }, { x: 110, y: 80 }), {
    body: "M 10 20 C 52 20, 68 80, 94 80 L 100 80",
    arrow: "M 100 80 L 110 80",
  });
});

test("dependencyPaths makes a backward dependency travel right to left", () => {
  assert.deepEqual(dependencyPaths({ x: 110, y: 20 }, { x: 10, y: 80 }), {
    body: "M 110 20 C 68 20, 52 80, 26 80 L 20 80",
    arrow: "M 20 80 L 10 80",
  });
});

test("dependencyPaths gives vertically aligned finishes room to curve and dock", () => {
  assert.deepEqual(dependencyPaths({ x: 40, y: 20 }, { x: 40, y: 80 }), {
    body: "M 40 20 C 72 20, 8 80, 24 80 L 30 80",
    arrow: "M 30 80 L 40 80",
  });
});
