import { strict as assert } from "node:assert";
import { test } from "node:test";
import { scrollOffset, type Axis } from "./scroll";

// A scroller showing 400px, the top 100 of which is under pinned furniture:
// content between `scroll + 100` and `scroll + 400` is what a reader can see.
function axis(scroll: number): Axis {
  return { scroll, client: 400, inset: 100 };
}

test("nearest leaves a row that is already readable where it is", () => {
  assert.equal(scrollOffset("nearest", 200, 30, axis(0)), 0);
  assert.equal(scrollOffset("nearest", 1000, 30, axis(900)), 900);
});

// The bug this arithmetic exists for: a row above the readable band is not
// above the viewport, so scrolling it to the viewport's edge leaves it under
// the furniture. It has to clear the inset instead.
test("nearest clears the pinned inset when scrolling backwards", () => {
  assert.equal(scrollOffset("nearest", 950, 30, axis(900)), 850);
});

test("nearest scrolls forward only to the trailing edge", () => {
  assert.equal(scrollOffset("nearest", 1290, 30, axis(900)), 920);
});

// Longer than the band and hanging off its far end: scrolling to that far end
// would push the leading edge — the part being acted on — behind the pinned
// furniture, so the leading edge wins instead.
test("something longer than the readable band is shown from its leading edge", () => {
  assert.equal(scrollOffset("nearest", 700, 1000, axis(450)), 600);
});

// The case a long bar hits: its leading edge is behind the pinned furniture
// while it covers everything the reader can see. There is nothing to bring
// into view, so the band must not move.
test("nearest leaves something spanning the whole readable band alone", () => {
  assert.equal(scrollOffset("nearest", 800, 600, axis(900)), 900);
});

test("center puts the middle of the row in the middle of the readable band", () => {
  // Row centre 515 lands 250 below the scroller's top: 100 of inset plus half
  // of the 300 that is left.
  assert.equal(scrollOffset("center", 500, 30, axis(0)), 265);
});
