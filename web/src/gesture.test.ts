import { test } from "node:test";
import assert from "node:assert/strict";
import { DoubleClickDetector, type Click } from "./gesture";

function at(id: number, x: number, y: number, at: number): Click {
  return { id, x, y, at };
}

test("two quick clicks on the same target are a double click", () => {
  const d = new DoubleClickDetector();
  assert.equal(d.click(at(1, 100, 50, 1000)), false);
  assert.equal(d.click(at(1, 102, 51, 1300)), true);
});

test("clicks on different targets never pair", () => {
  const d = new DoubleClickDetector();
  assert.equal(d.click(at(1, 100, 50, 1000)), false);
  assert.equal(d.click(at(2, 100, 50, 1100)), false);
});

test("slow clicks never pair", () => {
  const d = new DoubleClickDetector();
  assert.equal(d.click(at(1, 100, 50, 1000)), false);
  assert.equal(d.click(at(1, 100, 50, 1401)), false);
});

test("clicks far apart never pair, even on the same target", () => {
  const d = new DoubleClickDetector();
  assert.equal(d.click(at(1, 100, 50, 1000)), false);
  assert.equal(d.click(at(1, 200, 50, 1100)), false); // other end of a wide bar
});

test("a triple click yields one double, then a fresh candidate", () => {
  const d = new DoubleClickDetector();
  assert.equal(d.click(at(1, 100, 50, 1000)), false);
  assert.equal(d.click(at(1, 100, 50, 1100)), true);
  assert.equal(d.click(at(1, 100, 50, 1200)), false); // starts a new pair
  assert.equal(d.click(at(1, 100, 50, 1300)), true);
});

test("the second failed click becomes the new candidate", () => {
  const d = new DoubleClickDetector();
  assert.equal(d.click(at(1, 100, 50, 1000)), false);
  assert.equal(d.click(at(2, 300, 50, 1100)), false);
  // Pairs with the click on 2, not with the stale click on 1.
  assert.equal(d.click(at(2, 300, 50, 1200)), true);
});

test("reset breaks the pair", () => {
  const d = new DoubleClickDetector();
  assert.equal(d.click(at(1, 100, 50, 1000)), false);
  d.reset();
  assert.equal(d.click(at(1, 100, 50, 1100)), false);
});
