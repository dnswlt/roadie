// Gesture tests for the WBS outline (wbs-dnd.ts). E2E exists for the one seam
// no unit test can reach: pointer gestures against real layout —
// elementFromPoint, bounding boxes, and the class contracts between renderer
// and controller mean nothing in Node. Everything that CAN be tested DOM-free
// stays in src/*.test.ts (AGENTS.md).
//
// The pattern, binding for every e2e test:
//
//   seed via API  →  act via pointer  →  assert via API  →  purge.
//
// The UI is the actuator; the model is the oracle. No DOM content assertions
// and no screenshots: the only selectors used are the .wbs-* class contracts
// the controller itself hit-tests, so a failure here means a broken gesture,
// never a renamed label or a restyle.

import { expect, test, type Page } from "@playwright/test";
import { laneItems, markFlagged, purgeRoadmap, seedRoadmap, type Seeded } from "./support";
import { pickFilter } from "./ui";

let seeded: Seeded;

test.beforeEach(async ({ request }) => {
  seeded = await seedRoadmap(request, ["Alpha", "Beta", "Gamma"]);
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

function row(page: Page, itemId: number) {
  return page.locator(`.wbs-row[data-item-id="${itemId}"]`);
}

// openWbs loads the seeded roadmap directly in WBS view. The view preference
// is planted in localStorage before boot — arrange, not act: the "v" toggle
// is not what these tests pin down.
async function openWbs(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("roadie.view", "wbs"));
  await page.goto(`/?roadmap=${seeded.roadmapId}`);
  for (const it of seeded.items) {
    await expect(row(page, it.id)).toBeVisible();
  }
}

// dragTo presses on the center of `itemId`'s row and releases at (x, y),
// moving in steps so the controller sees real pointermoves — its 4px start
// threshold and its live drop-target resolution both depend on them.
async function dragTo(page: Page, itemId: number, x: number, y: number): Promise<void> {
  const box = (await row(page, itemId).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
}

test("dragging a row below the last block reorders it to the end", async ({ page, request }) => {
  await openWbs(page);
  const [alpha, , gamma] = seeded.items;

  // Release just below Gamma's block, inside the lane's bottom padding —
  // gaps and padding are insertion space, whereas a top-level row itself is a
  // nest target (pinned by the test below).
  const g = (await row(page, gamma!.id).boundingBox())!;
  await dragTo(page, alpha!.id, g.x + g.width / 2, g.y + g.height + 4);

  // Poll: the PATCH is issued after pointerup (optimistic apply, then API).
  await expect
    .poll(async () => (await laneItems(request, seeded.roadmapId, seeded.laneId)).map((i) => i.title))
    .toEqual(["Beta", "Gamma", "Alpha"]);
  const items = await laneItems(request, seeded.roadmapId, seeded.laneId);
  expect(items.map((i) => i.rank)).toEqual([0, 1, 2]); // ranks stay dense
});

test("dropping a row onto a top-level row nests it under that item", async ({ page, request }) => {
  await openWbs(page);
  const [alpha, beta] = seeded.items;

  const a = (await row(page, alpha!.id).boundingBox())!;
  await dragTo(page, beta!.id, a.x + a.width / 2, a.y + a.height / 2);

  await expect
    .poll(async () => {
      const items = await laneItems(request, seeded.roadmapId, seeded.laneId);
      return items.find((i) => i.id === alpha!.id)?.children.map((c) => c.title) ?? [];
    })
    .toEqual(["Beta"]);
  const items = await laneItems(request, seeded.roadmapId, seeded.laneId);
  const child = items.find((i) => i.id === alpha!.id)!.children[0]!;
  expect(child.parentId).toBe(alpha!.id);
  expect(child.laneId).toBe(seeded.laneId); // a child's lane always equals its parent's
  expect(items.map((i) => i.title)).toEqual(["Alpha", "Gamma"]); // Beta left the top level
});

test("filtering blocks WBS item rearrangement", async ({ page, request }) => {
  const [alpha, beta, gamma] = seeded.items;
  await markFlagged(request, alpha!.id);
  await markFlagged(request, gamma!.id);
  await openWbs(page);
  await pickFilter(page, /^Flagged \(/);

  // Alpha below the last block — the same gesture the reorder test above pins,
  // so a failure here is the filter, not the geometry.
  const g = (await row(page, gamma!.id).boundingBox())!;
  await dragTo(page, alpha!.id, g.x + g.width / 2, g.y + g.height + 4);

  // Proving nothing happened needs a later something that did. Clearing the
  // filter and reordering Beta gives an order that is only reachable if Alpha
  // never moved: had the blocked drag landed, the model would read
  // ["Beta", "Gamma", "Alpha"] here and this same gesture would end
  // ["Gamma", "Alpha", "Beta"] instead.
  await pickFilter(page, "Show all");
  await expect(row(page, beta!.id)).toBeVisible();
  const g2 = (await row(page, gamma!.id).boundingBox())!;
  await dragTo(page, beta!.id, g2.x + g2.width / 2, g2.y + g2.height + 4);

  await expect
    .poll(async () => (await laneItems(request, seeded.roadmapId, seeded.laneId)).map((i) => i.title))
    .toEqual(["Alpha", "Gamma", "Beta"]);
});
