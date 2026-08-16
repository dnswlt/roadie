// The popover registry's lifecycle, pinned without a DOM. What is tested here
// is the state machine — supersession, idempotence, and the stale-handle guard
// that keeps a superseded popover from dismissing its replacement — because
// that is the part hand-clicking is least likely to catch and a wrong answer
// is invisible until two popovers are open at once.
//
// The containment check needs real elements, so it is only exercised through
// `dismissesOn` with stubs here; that a real click in a real browser reaches
// this module at all is the e2e spec's job (web/e2e/popover-dismiss.spec.ts).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { closeAnyPopover, dismissesOn, openPopover } from "./popover";

// popover.ts reaches for document lazily (wire(), on the first open), so this
// stand-in only has to exist before the first test runs, not before the import.
const listeners: Array<(e: { target: unknown }) => void> = [];
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    addEventListener(type: string, fn: (e: { target: unknown }) => void, capture?: boolean) {
      // The capture flag is the whole mechanism: a bubble-phase listener would
      // let an opener register its popover before this ran, and the popover
      // would dismiss itself on the click that opened it.
      assert.equal(type, "click");
      assert.equal(capture, true);
      listeners.push(fn);
    },
  },
});

// A stand-in for an element: `contains` answers only for itself.
function el(name: string): Element {
  const node = { name, contains: (other: unknown) => other === node };
  return node as unknown as Element;
}

// Click somewhere the registry is listening, as the capture listener would.
function clickOn(target: unknown): void {
  for (const fn of listeners) fn({ target });
}

test("opening a popover dismisses the one already open", () => {
  const dismissed: string[] = [];
  const first = openPopover({ root: el("a"), onDismiss: () => dismissed.push("a") });
  assert.equal(first.isOpen(), true);

  const second = openPopover({ root: el("b"), onDismiss: () => dismissed.push("b") });
  assert.deepEqual(dismissed, ["a"]);
  assert.equal(first.isOpen(), false);
  assert.equal(second.isOpen(), true);

  second.close();
  assert.deepEqual(dismissed, ["a", "b"]);
});

test("close is idempotent — onDismiss runs exactly once per handle", () => {
  let count = 0;
  const handle = openPopover({ root: el("a"), onDismiss: () => count++ });
  handle.close();
  handle.close();
  handle.close();
  assert.equal(count, 1);
  assert.equal(handle.isOpen(), false);
});

// The reason owners are handed a handle instead of calling their own teardown:
// a late close from a popover that is already gone must not take down the one
// that replaced it.
test("a superseded handle can never dismiss its replacement", () => {
  const dismissed: string[] = [];
  const stale = openPopover({ root: el("a"), onDismiss: () => dismissed.push("a") });
  const live = openPopover({ root: el("b"), onDismiss: () => dismissed.push("b") });
  assert.deepEqual(dismissed, ["a"]);

  stale.close(); // arrives late, e.g. from a teardown path that kept the handle
  assert.deepEqual(dismissed, ["a"], "replacement must survive");
  assert.equal(live.isOpen(), true);

  live.close();
  assert.deepEqual(dismissed, ["a", "b"]);
});

test("a click inside the popover or its opener is not a dismissal", () => {
  const root = el("root");
  const opener = el("opener");
  const handle = openPopover({ root, opener, onDismiss: () => undefined });

  assert.equal(dismissesOn(root as unknown as Node), false);
  assert.equal(dismissesOn(opener as unknown as Node), false);
  assert.equal(dismissesOn(el("elsewhere") as unknown as Node), true);
  handle.close();

  // With nothing open there is nothing to dismiss, whatever was clicked.
  assert.equal(dismissesOn(el("elsewhere") as unknown as Node), false);
});

test("a click outside closes through the capture listener", () => {
  let open = true;
  const root = el("root");
  const handle = openPopover({ root, onDismiss: () => (open = false) });

  clickOn(root); // inside: survives
  assert.equal(open, true);
  assert.equal(handle.isOpen(), true);

  clickOn(el("elsewhere"));
  assert.equal(open, false);
  assert.equal(handle.isOpen(), false);

  // A further click with nothing open must not throw or re-dismiss.
  clickOn(el("elsewhere"));
  assert.equal(open, false);
});

// The reconciliation view rebuilds its DOM while a popover is open, so an
// anchor may be a lookup rather than a node. Containment must follow the
// replacement, not the node that was current at open time.
test("a lazily resolved anchor follows a rebuilt DOM", () => {
  let live = el("first");
  let open = true;
  openPopover({ root: () => live, onDismiss: () => (open = false) });

  clickOn(live);
  assert.equal(open, true);

  live = el("rebuilt"); // the view re-rendered underneath the popover
  clickOn(live);
  assert.equal(open, true, "a click in the rebuilt body is still inside");

  clickOn(el("elsewhere"));
  assert.equal(open, false);
});

// A lookup that finds nothing means the popover's DOM is gone; the next click
// anywhere should clear the registration rather than leave it stuck open.
test("an anchor that resolves to null dismisses on the next click", () => {
  let open = true;
  openPopover({ root: () => null, onDismiss: () => (open = false) });
  clickOn(el("anything"));
  assert.equal(open, false);
});

test("closeAnyPopover dismisses without holding the handle, and is safe when nothing is open", () => {
  let count = 0;
  openPopover({ root: el("a"), onDismiss: () => count++ });
  closeAnyPopover();
  assert.equal(count, 1);
  closeAnyPopover();
  assert.equal(count, 1);
});
