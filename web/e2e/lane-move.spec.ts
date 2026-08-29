// Context ordering uses a compact replacement popover rather than dragging a
// full-height lane. The browser is the subject here: the actions menu must hand
// off to the destination picker, whose list includes contexts absent from the
// rendered projection. Persistence is asserted through the API.

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { addLane, purgeRoadmap, seedRoadmap, type Seeded } from "./support";

let seeded: Seeded;
let hiddenId: number;
let targetId: number;
let lastId: number;

test.beforeEach(async ({ request }) => {
  seeded = await seedRoadmap(request, []);
  hiddenId = await addLane(request, seeded.roadmapId, "Hidden");
  targetId = await addLane(request, seeded.roadmapId, "Target");
  lastId = await addLane(request, seeded.roadmapId, "Last");
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

async function laneOrder(request: APIRequestContext): Promise<number[]> {
  const response = await request.get(`/api/roadmaps/${seeded.roadmapId}`);
  expect(response.ok(), `GET roadmap -> ${response.status()}`).toBe(true);
  const roadmap = (await response.json()) as { lanes: { id: number }[] };
  return roadmap.lanes.map((lane) => lane.id);
}

async function open(page: Page): Promise<void> {
  await page.addInitScript(
    ({ roadmapId, laneId }) => {
      localStorage.setItem("roadie.view", "timeline");
      localStorage.setItem(`roadie.hidden.${roadmapId}`, JSON.stringify([laneId]));
    },
    { roadmapId: seeded.roadmapId, laneId: hiddenId },
  );
  await page.goto(`/?roadmap=${seeded.roadmapId}`);
  await expect(page.locator(`.lane[data-lane-id="${seeded.laneId}"]`)).toBeVisible();
  await expect(page.locator(`.lane[data-lane-id="${hiddenId}"]`)).toHaveCount(0);
}

async function openMoveMenu(page: Page): Promise<void> {
  await page
    .locator(`.lane[data-lane-id="${seeded.laneId}"] .lane-menu-btn`)
    .click();
  await page.getByRole("button", { name: "Move context…", exact: true }).click();
  await expect(page.locator(".lane-move-menu")).toBeVisible();
}

test("a context moves above any roadmap context or to the bottom", async ({ page, request }) => {
  await open(page);
  await openMoveMenu(page);

  // Hidden is the context immediately after Lane, hence both a destination
  // absent from the chart and the disabled slot representing the current order.
  const hidden = page.locator(".lane-move-item", { hasText: "Hidden" });
  await expect(hidden).toBeVisible();
  await expect(hidden).toBeDisabled();
  await expect(hidden).toContainText("Current");

  await page.getByRole("button", { name: "Last", exact: true }).click();
  await expect
    .poll(() => laneOrder(request))
    .toEqual([hiddenId, targetId, seeded.laneId, lastId]);

  await openMoveMenu(page);
  await page.getByRole("button", { name: "Move to bottom", exact: true }).click();
  await expect
    .poll(() => laneOrder(request))
    .toEqual([hiddenId, targetId, lastId, seeded.laneId]);
});
