// Milestone label visibility and collision boundaries depend on browser text
// layout. Pin only those relationships here: no screenshots, exact pixels, or
// stylesheet details.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { addMilestone, purgeRoadmap, seedRoadmap, type Seeded } from "./support";

let seeded: Seeded;
let shortId: number;
let longId: number;
let nextId: number;

test.beforeEach(async ({ request }) => {
  seeded = await seedRoadmap(request, []);
  shortId = await addMilestone(request, seeded.laneId, "3er", "2027-08-01");
  const marked = await request.patch(`/api/milestones/${shortId}`, {
    data: { flagged: true, atRisk: true },
  });
  expect(marked.ok()).toBe(true);
  longId = await addMilestone(
    request,
    seeded.laneId,
    "First milestone First milestone First milestone First milestone First milestone",
    "2027-08-21",
  );
  nextId = await addMilestone(request, seeded.laneId, "Old milestone", "2028-02-01");
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

function milestone(page: Page, id: number): Locator {
  return page.locator(`.milestone[data-milestone-id="${id}"]`);
}

async function expectLabelBefore(label: Locator, following: Locator): Promise<void> {
  const [labelBox, followingBox] = await Promise.all([
    label.boundingBox(),
    following.locator(".milestone-diamond").boundingBox(),
  ]);
  expect(labelBox).not.toBeNull();
  expect(followingBox).not.toBeNull();
  expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(followingBox!.x);
}

async function expectNoOverlap(label: Locator, following: Locator): Promise<void> {
  const [labelBox, followingBox] = await Promise.all([
    label.boundingBox(),
    following.locator(".milestone-diamond").boundingBox(),
  ]);
  expect(labelBox).not.toBeNull();
  expect(followingBox).not.toBeNull();
  expect(
    labelBox!.x + labelBox!.width <= followingBox!.x ||
      followingBox!.x + followingBox!.width <= labelBox!.x ||
      labelBox!.y + labelBox!.height <= followingBox!.y ||
      followingBox!.y + followingBox!.height <= labelBox!.y,
  ).toBe(true);
}

test("keeps short and interactive milestone labels within their packed interval", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("roadie.view", "timeline"));
  await page.goto(`/?roadmap=${seeded.roadmapId}`);

  const shortTitle = milestone(page, shortId).locator(".milestone-title");
  await expect(shortTitle).toBeVisible();
  await expect(shortTitle).toHaveText("3er");
  await expect(milestone(page, shortId).locator(".bar-flag")).toBeVisible();
  await expect(milestone(page, shortId).locator(".bar-risk")).toBeVisible();

  const long = milestone(page, longId);
  await expectNoOverlap(milestone(page, shortId).locator(".milestone-label"), long);
  const label = long.locator(".milestone-label");
  const following = milestone(page, nextId);
  await expectLabelBefore(label, following);

  await long.locator(".milestone-diamond").hover();
  await expectLabelBefore(label, following);

  await long.locator(".milestone-diamond").click();
  await expect(long).toHaveClass(/selected/);
  await expectLabelBefore(label, following);
});
