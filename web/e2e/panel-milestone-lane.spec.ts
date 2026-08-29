// The item and milestone panel Context dropdowns. Milestones need the picker
// because their point marker has no separate vertical drag gesture; items need
// it so a distant context does not require dragging while scrolling.
//
// Same shape as the other panel spec: seed via API → pick in the browser →
// assert via API → purge. One assertion reads the DOM, for the same reason
// panel-schedule.spec.ts does: a pick keeps focus in the select, so the panel
// skips its rebuild and the control has to keep itself honest — a dropdown
// still naming the old context would make picking it back a no-op event.

import { expect, test, type Page } from "@playwright/test";
import {
  addLane,
  addItem,
  addMilestone,
  laneItems,
  laneMilestones,
  purgeRoadmap,
  seedRoadmap,
  type Seeded,
} from "./support";

let seeded: Seeded;
let otherLaneId: number;
let milestoneId: number;

test.beforeEach(async ({ request }) => {
  seeded = await seedRoadmap(request, ["Work"]);
  otherLaneId = await addLane(request, seeded.roadmapId, "Platform");
  milestoneId = await addMilestone(request, seeded.laneId, "GA", "2026-02-10");
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

const contextSelect = (page: Page) => page.locator('#panel select[aria-label="Context"]');

async function openMilestone(page: Page): Promise<void> {
  await page.goto(`/?roadmap=${seeded.roadmapId}&milestone=${milestoneId}`);
  await contextSelect(page).waitFor();
}

async function openItem(page: Page, itemId: number): Promise<void> {
  await page.goto(`/?roadmap=${seeded.roadmapId}&item=${itemId}`);
  await contextSelect(page).waitFor();
}

async function shown(page: Page): Promise<string> {
  return (await contextSelect(page).locator("option:checked").innerText()).trim();
}

test("picking a context moves the milestone to that lane", async ({ page, request }) => {
  await openMilestone(page);
  expect(await shown(page)).toBe("Lane");

  await contextSelect(page).selectOption({ label: "Platform" });

  await expect
    .poll(async () => (await laneMilestones(request, seeded.roadmapId, otherLaneId)).length)
    .toBe(1);
  expect(await laneMilestones(request, seeded.roadmapId, seeded.laneId)).toEqual([]);
  // The panel stayed open on the same milestone, and the dropdown reports
  // where it now lives — so picking the original context back is reachable.
  expect(await shown(page)).toBe("Platform");

  await contextSelect(page).selectOption({ label: "Lane" });
  await expect
    .poll(async () => (await laneMilestones(request, seeded.roadmapId, seeded.laneId)).length)
    .toBe(1);
});

test("the moved milestone is redrawn under its new lane", async ({ page }) => {
  await openMilestone(page);
  const marker = (laneId: number) =>
    page.locator(`.lane[data-lane-id="${laneId}"] .milestone[data-milestone-id="${milestoneId}"]`);
  await expect(marker(seeded.laneId)).toBeVisible();

  await contextSelect(page).selectOption({ label: "Platform" });

  // The chart follows the move without a reload — the marker is now a
  // descendant of the other lane's row, and of no other.
  await expect(marker(otherLaneId)).toBeVisible();
  await expect(marker(seeded.laneId)).toHaveCount(0);
});

test("picking a context moves an item to that lane", async ({ page, request }) => {
  const itemId = seeded.items[0]!.id;
  await openItem(page, itemId);
  expect(await shown(page)).toBe("Lane");

  await contextSelect(page).selectOption({ label: "Platform" });

  await expect
    .poll(async () => (await laneItems(request, seeded.roadmapId, otherLaneId))[0]?.id)
    .toBe(itemId);
  expect(await laneItems(request, seeded.roadmapId, seeded.laneId)).toEqual([]);
  expect(await shown(page)).toBe("Platform");
  await expect(
    page.locator(`.lane[data-lane-id="${otherLaneId}"] .bar[data-item-id="${itemId}"]`),
  ).toBeVisible();
});

test("moving a child to another context makes it top-level", async ({ page, request }) => {
  const parentId = seeded.items[0]!.id;
  const childId = await addItem(request, seeded.laneId, "Child", parentId);
  await openItem(page, childId);
  await expect(page.locator("#panel .panel-kind")).toHaveText("Child item");

  await contextSelect(page).selectOption({ label: "Platform" });

  await expect
    .poll(async () => {
      const source = await laneItems(request, seeded.roadmapId, seeded.laneId);
      const target = await laneItems(request, seeded.roadmapId, otherLaneId);
      return {
        sourceChildren: source[0]?.children.map((item) => item.id),
        target: target.map((item) => ({
          id: item.id,
          laneId: item.laneId,
          parentId: item.parentId,
        })),
      };
    })
    .toEqual({
      sourceChildren: [],
      target: [{ id: childId, laneId: otherLaneId, parentId: null }],
    });
  await expect(page.locator("#panel .panel-kind")).toHaveText("Item");
  await expect(page.getByRole("button", { name: "Add Child", exact: true })).toBeVisible();
});
