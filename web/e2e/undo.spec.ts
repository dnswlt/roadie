// Undo and redo (undo.ts, bound to the platform's edit chord in keys.ts). The
// same narrow contract the other gesture specs follow:
//
//   seed via API  →  act via keyboard  →  assert via API  →  purge.
//
// inverseOf and the stack are pinned DOM-free in src/undo.test.ts. What only a
// browser can show is that the chord reaches them at all — keys.ts turns every
// other Ctrl/Cmd combination away — that the inverse travels to the server
// rather than only to the local model, and that the two guards around it hold:
// the caret in a text field keeps the chord, and a create empties the stack.

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  addItem,
  addLane,
  addMilestone,
  laneItems,
  laneMilestones,
  purgeRoadmap,
  seedRoadmap,
  type Seeded,
} from "./support";

let seeded: Seeded;

test.beforeEach(async ({ request }) => {
  seeded = await seedRoadmap(request, ["Alpha", "Beta", "Gamma"]);
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

function bar(page: Page, itemId: number) {
  return page.locator(`.bar[data-item-id="${itemId}"]`);
}

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("roadie.view", "timeline"));
  await page.goto(`/?roadmap=${seeded.roadmapId}`);
}

async function titles(request: Parameters<typeof laneItems>[0]): Promise<string[]> {
  return (await laneItems(request, seeded.roadmapId, seeded.laneId)).map((i) => i.title);
}

test("the edit chord undoes a move and redoes it", async ({ page, request }) => {
  await open(page);
  await bar(page, seeded.items[0]!.id).click();

  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => titles(request)).toEqual(["Beta", "Alpha", "Gamma"]);

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => titles(request)).toEqual(["Alpha", "Beta", "Gamma"]);

  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => titles(request)).toEqual(["Beta", "Alpha", "Gamma"]);
});

// An undo the user cannot see reads as a broken shortcut, so the entity it
// touched is revealed and selected — even when the selection has moved on.
test("an undo selects the item it put back", async ({ page, request }) => {
  await open(page);
  const alpha = seeded.items[0]!;
  await bar(page, alpha.id).click();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => titles(request)).toEqual(["Beta", "Alpha", "Gamma"]);

  await bar(page, seeded.items[2]!.id).click();
  await expect(page.locator(".block.selected")).toHaveAttribute(
    "data-item-id",
    String(seeded.items[2]!.id),
  );

  await page.keyboard.press("ControlOrMeta+z");

  await expect(page.locator(".block.selected")).toHaveAttribute("data-item-id", String(alpha.id));
});

// While the caret sits in a field, the chord is the browser's own text undo.
// The move made before the field was opened is the observable: if the binding
// fired, it would be the thing that came back.
test("the chord stays the browser's inside a text field", async ({ page, request }) => {
  await open(page);
  await bar(page, seeded.items[0]!.id).click();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => titles(request)).toEqual(["Beta", "Alpha", "Gamma"]);

  const title = page.locator("#panel .panel-title-input");
  await title.click();
  await expect(title).toBeFocused();
  await page.keyboard.press("ControlOrMeta+z");

  await expect(page.locator("#toasts .toast")).toHaveCount(0);
  expect(await titles(request)).toEqual(["Beta", "Alpha", "Gamma"]);
});

// A create is not an Edit: re-creating an item issues a new database id, so
// nothing after one can be inverted and the whole stack goes. The toast is what
// makes that visible — without it, "refused" and "not answered yet" are the
// same picture.
test("a create empties the stack, and the chord says so", async ({ page, request }) => {
  await open(page);
  await bar(page, seeded.items[0]!.id).click();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(() => titles(request)).toEqual(["Beta", "Alpha", "Gamma"]);

  // "n" leaves the caret in the new item's title field, where the chord would
  // be the browser's; Escape finishes that edit the way a user does.
  await page.keyboard.press("n");
  await expect.poll(async () => (await titles(request)).length).toBe(4);
  await page.keyboard.press("Escape");
  await expect(page.locator("#panel .panel-title-input")).not.toBeFocused();

  await page.keyboard.press("ControlOrMeta+z");

  await expect(page.locator("#toasts .toast")).toBeVisible();
  // The new item sits where "n" put it, next to the one that was selected; the
  // move ahead of it is the part that must not have come back.
  expect((await titles(request)).filter((t) => t !== "New item")).toEqual([
    "Beta",
    "Alpha",
    "Gamma",
  ]);
});

// The milestone path, and the panel as the gesture surface: a <select> owns no
// characters, so the chord is ours while its focus is still there.
test("an undo puts a milestone back in the context it left", async ({ page, request }) => {
  const otherLaneId = await addLane(request, seeded.roadmapId, "Platform");
  const milestoneId = await addMilestone(request, seeded.laneId, "GA", "2026-02-10");
  await page.goto(`/?roadmap=${seeded.roadmapId}&milestone=${milestoneId}`);
  const context = page.locator('#panel select[aria-label="Context"]');
  await context.waitFor();

  await context.selectOption({ label: "Platform" });
  await expect
    .poll(async () => (await laneMilestones(request, seeded.roadmapId, otherLaneId)).length)
    .toBe(1);

  await page.keyboard.press("ControlOrMeta+z");

  await expect
    .poll(async () => (await laneMilestones(request, seeded.roadmapId, seeded.laneId)).length)
    .toBe(1);
  expect(await laneMilestones(request, seeded.roadmapId, otherLaneId)).toEqual([]);
});

// A context reorder is the one Edit that names no entity to jump to: the rail
// itself is what moved, and the order has to come back all the same.
test("an undo restores the context order", async ({ page, request }) => {
  const secondId = await addLane(request, seeded.roadmapId, "Second");
  const thirdId = await addLane(request, seeded.roadmapId, "Third");
  const order = async (r: APIRequestContext): Promise<number[]> => {
    const response = await r.get(`/api/roadmaps/${seeded.roadmapId}`);
    expect(response.ok(), `GET roadmap -> ${response.status()}`).toBe(true);
    return ((await response.json()) as { lanes: { id: number }[] }).lanes.map((l) => l.id);
  };
  await open(page);
  expect(await order(request)).toEqual([seeded.laneId, secondId, thirdId]);

  await page.locator(`.lane[data-lane-id="${seeded.laneId}"] .lane-menu-btn`).click();
  await page.getByRole("button", { name: "Move context…", exact: true }).click();
  await page.getByRole("button", { name: "Move to bottom", exact: true }).click();
  await expect.poll(() => order(request)).toEqual([secondId, thirdId, seeded.laneId]);

  await page.keyboard.press("ControlOrMeta+z");

  await expect.poll(() => order(request)).toEqual([seeded.laneId, secondId, thirdId]);
});

// The edit panel repaints its own controls on the click that changed them and
// skips rebuilding while it holds focus, so a replay has to say that the panel
// is no longer showing what the user clicked.
test("an undo repaints the panel control it changed", async ({ page, request }) => {
  await open(page);
  await bar(page, seeded.items[0]!.id).click();
  const p2 = page.locator("#panel .prio-chip", { hasText: "P2" });
  await p2.click();
  await expect(p2).toHaveClass(/active/);
  await expect
    .poll(async () => (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!.priority)
    .toBe(2);

  await page.keyboard.press("ControlOrMeta+z");

  await expect(p2).not.toHaveClass(/active/);
  // The chip repaints from the optimistic apply, which is ahead of the PATCH:
  // poll, so a slow request cannot read as a failure to persist.
  await expect
    .poll(async () => (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!.priority)
    .toBe(null);
});

// The one state the client cannot edit its way out of: a gesture whose requests
// did not all succeed, and whose resync then failed as well. Both failures are
// arranged in the browser, since neither is reachable from a working server.
test("a part-saved gesture with no resync asks for a reload", async ({ page, request }) => {
  await open(page);
  const [alpha, beta] = [seeded.items[0]!, seeded.items[1]!];
  await bar(page, alpha.id).click();
  await bar(page, beta.id).click({ modifiers: ["Shift"] });

  // One of the two flag PATCHes lands, the other never does, and the roadmap
  // the recovery would have reloaded is unreachable too.
  await page.route(`**/api/items/${beta.id}`, (route) => route.abort());
  await page.route(`**/api/roadmaps/${seeded.roadmapId}`, (route) => route.abort());
  await page.keyboard.press("!");

  const reloadBar = page.locator("#reload-bar");
  await expect(reloadBar).toBeVisible();
  await expect(reloadBar).toContainText("Some changes may have saved");
  await expect(reloadBar.getByRole("button", { name: "Reload" })).toBeVisible();
  // The half that did land is on the server, which is what the message is about.
  expect((await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!.flagged).toBe(true);
});

// A move is one atom: the inverse asks for a context, a parent and a rank, and
// the server's own splice has to land the item back between the siblings it
// left. Only a round trip can show that — src/undo.test.ts pins the three
// values, not what the store does with them.
test("an undo puts an item back between the siblings it left", async ({ page, request }) => {
  const otherLaneId = await addLane(request, seeded.roadmapId, "Platform");
  const beta = seeded.items[1]!;
  await page.goto(`/?roadmap=${seeded.roadmapId}&item=${beta.id}`);
  const context = page.locator('#panel select[aria-label="Context"]');
  await context.waitFor();

  await context.selectOption({ label: "Platform" });
  await expect
    .poll(async () => (await laneItems(request, seeded.roadmapId, otherLaneId)).map((i) => i.title))
    .toEqual(["Beta"]);

  await page.keyboard.press("ControlOrMeta+z");

  // Back in its own context, at its own rank — not appended to the end.
  await expect.poll(() => titles(request)).toEqual(["Alpha", "Beta", "Gamma"]);
  expect(await laneItems(request, seeded.roadmapId, otherLaneId)).toEqual([]);
});

// Nesting is the other half of a move: restoring a child means its parent, its
// context and its slot among its siblings, all three at once.
test("an undo puts a child back under its parent", async ({ page, request }) => {
  const otherLaneId = await addLane(request, seeded.roadmapId, "Platform");
  const alpha = seeded.items[0]!;
  await addItem(request, seeded.laneId, "First", alpha.id);
  const second = await addItem(request, seeded.laneId, "Second", alpha.id);
  await addItem(request, seeded.laneId, "Third", alpha.id);
  const children = async (): Promise<string[]> => {
    const items = await laneItems(request, seeded.roadmapId, seeded.laneId);
    return (items.find((i) => i.id === alpha.id)?.children ?? []).map((c) => c.title);
  };
  await page.goto(`/?roadmap=${seeded.roadmapId}&item=${second}`);
  const context = page.locator('#panel select[aria-label="Context"]');
  await context.waitFor();

  // Moving a child to another context is also what un-nests it.
  await context.selectOption({ label: "Platform" });
  await expect.poll(children).toEqual(["First", "Third"]);

  await page.keyboard.press("ControlOrMeta+z");

  await expect.poll(children).toEqual(["First", "Second", "Third"]);
  expect(await laneItems(request, seeded.roadmapId, otherLaneId)).toEqual([]);
});

// Two gestures can be in flight together without either being a race: a drag
// re-renders, the re-render tears down a panel field left half-typed, and that
// is what commits it — so the field's PATCH and the drag's always overlap.
// Recording them in response order would leave the stack in an order the
// cursor cannot describe and drop both.
test("a field committed by a drag is undoable, and so is the drag", async ({ page, request }) => {
  await open(page);
  const [alpha, beta] = [seeded.items[0]!, seeded.items[1]!];
  await bar(page, alpha.id).click();
  const title = page.locator("#panel .panel-title-input");
  await title.click();
  await title.fill("Alpha renamed");

  // Drag the other bar sideways: it commits Alpha's title on its way through
  // the render, then sends its own dates.
  const box = (await bar(page, beta.id).boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, y, { steps: 12 });
  await page.mouse.up();

  const item = async (id: number) =>
    (await laneItems(request, seeded.roadmapId, seeded.laneId)).find((i) => i.id === id)!;
  await expect.poll(async () => (await item(alpha.id)).title).toBe("Alpha renamed");
  await expect.poll(async () => (await item(beta.id)).startDate).not.toBe("2026-01-05");

  // The title was applied last, so it comes back first.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await item(alpha.id)).title).toBe("Alpha");

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await item(beta.id)).startDate).toBe("2026-01-05");
});
