// Gesture tests for timeline bars (dnd.ts). These follow the deliberately
// narrow e2e contract in wbs-drag.spec.ts:
//
//   seed via API  →  act via pointer  →  assert via API  →  purge.
//
// The browser is needed only for the pointer/layout seam. Snapping arithmetic
// remains covered DOM-free in snap.test.ts; here we pin that a real bar drag
// reaches that arithmetic, including the Alt/Option bypass handled by dnd.ts.

import { expect, test, type Page } from "@playwright/test";
import { laneItems, purgeRoadmap, seedRoadmap, type Seeded } from "./support";

let seeded: Seeded;
let monday: Date;

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function currentMonday(): Date {
  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const daysSinceMonday = (today.getUTCDay() + 6) % 7;
  return addDays(today, -daysSinceMonday);
}

test.beforeEach(async ({ request }) => {
  monday = currentMonday();
  seeded = await seedRoadmap(request, ["Alpha"], {
    startDate: iso(monday),
    endDate: iso(addDays(monday, 27)),
  });
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

function bar(page: Page, itemId: number) {
  return page.locator(`.bar[data-item-id="${itemId}"]`);
}

// Fix both view preferences that participate in the gesture. At 3 px/day a
// 12px pointer move is exactly four unsnapped days; weekly snapping moves the
// seeded Monday to the following Monday instead.
async function openTimeline(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("roadie.view", "timeline");
    localStorage.setItem("roadie.zoom", "3");
    localStorage.setItem("roadie.snap", "week");
  });
  await page.goto(`/?roadmap=${seeded.roadmapId}`);
  await expect(bar(page, seeded.items[0]!.id)).toBeVisible();
}

async function dragFourDays(page: Page, itemId: number, modifier: "Shift" | "Alt"): Promise<void> {
  const box = (await bar(page, itemId).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.keyboard.down(modifier);
  await page.mouse.move(x + 12, y, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up(modifier);
}

async function dates(request: Parameters<typeof laneItems>[0]): Promise<[string, string]> {
  const item = (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!;
  return [item.startDate, item.endDate];
}

test("dragging a timeline bar applies the selected snap grid", async ({ page, request }) => {
  await openTimeline(page);
  // Shift makes this specifically a grid-snap gesture: feature magnets,
  // including the always-present today boundary, do not participate.
  await dragFourDays(page, seeded.items[0]!.id, "Shift");

  await expect
    .poll(() => dates(request))
    .toEqual([iso(addDays(monday, 7)), iso(addDays(monday, 34))]);
});

test("holding Alt while dragging a timeline bar bypasses snapping", async ({ page, request }) => {
  await openTimeline(page);
  await dragFourDays(page, seeded.items[0]!.id, "Alt");

  await expect
    .poll(() => dates(request))
    .toEqual([iso(addDays(monday, 4)), iso(addDays(monday, 31))]);
});
