// The milestone panel's Context dropdown — the only way to move a milestone
// between contexts, since a milestone is a point with no width and a timeline
// drag could not tell "change the date" from "change the context" apart.
//
// Same shape as the other panel spec: seed via API → pick in the browser →
// assert via API → purge. One assertion reads the DOM, for the same reason
// panel-schedule.spec.ts does: a pick keeps focus in the select, so the panel
// skips its rebuild and the control has to keep itself honest — a dropdown
// still naming the old context would make picking it back a no-op event.

import { expect, test, type Page } from "@playwright/test";
import {
  addLane,
  addMilestone,
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
