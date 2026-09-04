// Gesture tests for timeline bars (dnd.ts). These follow the deliberately
// narrow e2e contract in wbs-drag.spec.ts:
//
//   seed via API  →  act via pointer  →  assert via API  →  purge.
//
// The browser is needed only for the pointer/layout seam. Snapping arithmetic
// remains covered DOM-free in snap.test.ts; here we pin that a real bar drag
// reaches that arithmetic, including the Alt/Option bypass handled by dnd.ts.

import { expect, test, type Page } from "@playwright/test";
import {
  addLane,
  addMilestone,
  laneItems,
  markFlagged,
  purgeRoadmap,
  seedRoadmap,
  setItemDates,
  type Seeded,
} from "./support";
import { pickFilter } from "./ui";

let seeded: Seeded;
let targetLaneId: number;
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
  seeded = await seedRoadmap(request, ["Alpha", "Beta"], {
    startDate: iso(monday),
    endDate: iso(addDays(monday, 27)),
  });
  targetLaneId = await addLane(request, seeded.roadmapId, "Target");
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

function bar(page: Page, itemId: number) {
  return page.locator(`.bar[data-item-id="${itemId}"]`);
}

function rightHandle(page: Page, itemId: number) {
  return bar(page, itemId).locator(".rh-r");
}

// Fix both view preferences that participate in the gesture. At 3 px/day a
// 12px pointer move is exactly four unsnapped days; weekly snapping moves the
// seeded Monday to the following Monday instead. "day" means no grid at all
// (timescale.ts), which is what the feature-magnet tests want: with no grid,
// SNAP_PX alone decides whether an edge is caught, so a magnet's presence or
// absence is the only thing the result can be measuring.
async function openTimeline(page: Page, snap: "week" | "day" = "week"): Promise<void> {
  await page.addInitScript((mode) => {
    localStorage.setItem("roadie.view", "timeline");
    localStorage.setItem("roadie.zoom", "3");
    localStorage.setItem("roadie.snap", mode);
  }, snap);
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

async function resizeFourDays(page: Page, itemId: number, modifier: "Shift" | "Alt"): Promise<void> {
  const box = (await rightHandle(page, itemId).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.keyboard.down(modifier);
  await page.mouse.move(x + 12, y, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up(modifier);
}

// resizeBy drags the right handle by an exact pixel delta with no modifier
// held, so snapping runs in full.
async function resizeBy(page: Page, itemId: number, dx: number): Promise<void> {
  const box = (await rightHandle(page, itemId).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 12 });
  await page.mouse.up();
}

async function dragToLane(page: Page, itemId: number, laneId: number): Promise<void> {
  const source = (await bar(page, itemId).boundingBox())!;
  const target = (await page.locator(`.lane[data-lane-id="${laneId}"] .lane-canvas`).boundingBox())!;
  const x = source.x + source.width / 2;
  await page.mouse.move(x, source.y + source.height / 2);
  await page.mouse.down();
  // Grid-only keeps the horizontal date position fixed without allowing the
  // always-present today feature magnet to influence this structural gesture.
  await page.keyboard.down("Shift");
  await page.mouse.move(x, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
}

async function dragOntoBar(page: Page, itemId: number, targetId: number): Promise<void> {
  const source = (await bar(page, itemId).boundingBox())!;
  const target = (await bar(page, targetId).boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  // As in the cross-lane case, keep this structural gesture date-neutral and
  // exclude feature magnets (especially today) from the pointer path.
  await page.keyboard.down("Shift");
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
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

test("dragging a timeline resize handle applies the selected snap grid", async ({ page, request }) => {
  await openTimeline(page);
  await resizeFourDays(page, seeded.items[0]!.id, "Shift");

  await expect
    .poll(() => dates(request))
    .toEqual([iso(monday), iso(addDays(monday, 34))]);
});

test("holding Alt while resizing a timeline bar bypasses snapping", async ({ page, request }) => {
  await openTimeline(page);
  await resizeFourDays(page, seeded.items[0]!.id, "Alt");

  await expect
    .poll(() => dates(request))
    .toEqual([iso(monday), iso(addDays(monday, 31))]);
});

test("filtering blocks bar moves but keeps resize handles active", async ({ page, request }) => {
  const id = seeded.items[0]!.id;
  await markFlagged(request, id);
  await openTimeline(page);
  await pickFilter(page, /^Flagged \(/);

  await dragFourDays(page, id, "Alt");
  // The resize is the barrier as well as the second half of the assertion: by
  // the time its PATCH has landed, a move mistakenly started by the drag above
  // would have landed too. A move shifts both dates, so the unchanged start is
  // what says the drag was refused — no fixed wait needed to prove the absence.
  await resizeFourDays(page, id, "Alt");
  await expect
    .poll(() => dates(request))
    .toEqual([iso(monday), iso(addDays(monday, 31))]);
});

// Feature magnets, and what the filter does to them. collectSnapBounds gathers
// its targets from the same projection the renderer draws (dnd.ts), so a bar the
// filter removed stops being a magnet — the rule a folded parent's children
// already follow, since an edge sticking to something you cannot see reads as a
// broken snap rather than as help.
//
// The arrangement puts Beta's start edge two days (6px at this zoom, inside
// SNAP_PX) beyond where the pointer leaves Alpha's right edge, and runs the
// identical pointer path in both tests. The first is the control: without it a
// pass in the second would prove only that the magnet never worked.
async function placeNeighbour(request: Parameters<typeof setItemDates>[0]): Promise<void> {
  await setItemDates(
    request,
    seeded.items[1]!.id,
    iso(addDays(monday, 40)),
    iso(addDays(monday, 60)),
  );
}

async function placeMilestone(request: Parameters<typeof setItemDates>[0]): Promise<void> {
  await addMilestone(request, seeded.laneId, "Target", iso(addDays(monday, 40)));
}

test("a resize snaps to a neighbouring bar's edge", async ({ page, request }) => {
  await placeNeighbour(request);
  await openTimeline(page, "day");

  // +30px = 10 days, landing the edge at monday+38; Beta's start at monday+40
  // catches it, so Alpha ends the day before Beta starts — flush, not overlapping.
  await resizeBy(page, seeded.items[0]!.id, 30);
  await expect.poll(() => dates(request)).toEqual([iso(monday), iso(addDays(monday, 39))]);
});

test("a resize does not snap to a bar the filter removed", async ({ page, request }) => {
  await placeNeighbour(request);
  await markFlagged(request, seeded.items[0]!.id); // Alpha survives, Beta does not
  await openTimeline(page, "day");
  await pickFilter(page, /^Flagged \(/);

  // Same gesture as the control. With Beta off the chart its edge is no longer
  // a target, so the edge stays where the pointer put it: monday+38, one day
  // short of the snapped result above.
  await resizeBy(page, seeded.items[0]!.id, 30);
  await expect.poll(() => dates(request)).toEqual([iso(monday), iso(addDays(monday, 37))]);
});

test("a resize snaps to a milestone", async ({ page, request }) => {
  await placeMilestone(request);
  await openTimeline(page, "day");

  await resizeBy(page, seeded.items[0]!.id, 30);
  await expect.poll(() => dates(request)).toEqual([iso(monday), iso(addDays(monday, 39))]);
});

test("a resize does not snap to a milestone the filter removed", async ({ page, request }) => {
  await placeMilestone(request);
  await markFlagged(request, seeded.items[0]!.id);
  await openTimeline(page, "day");
  await pickFilter(page, /^Flagged \(/);

  await resizeBy(page, seeded.items[0]!.id, 30);
  await expect.poll(() => dates(request)).toEqual([iso(monday), iso(addDays(monday, 37))]);
});

test("dragging a timeline bar into another lane moves it across lanes", async ({ page, request }) => {
  await openTimeline(page);
  await dragToLane(page, seeded.items[0]!.id, targetLaneId);

  await expect
    .poll(async () =>
      (await laneItems(request, seeded.roadmapId, seeded.laneId)).map((item) => item.title),
    )
    .toEqual(["Beta"]);
  await expect
    .poll(async () => {
      const item = (await laneItems(request, seeded.roadmapId, targetLaneId))[0];
      return item && {
        id: item.id,
        laneId: item.laneId,
        parentId: item.parentId,
        rank: item.rank,
        dates: [item.startDate, item.endDate],
      };
    })
    .toEqual({
      id: seeded.items[0]!.id,
      laneId: targetLaneId,
      parentId: null,
      rank: 0,
      dates: [iso(monday), iso(addDays(monday, 27))],
    });
});

test("dropping a timeline bar onto another bar nests it under that item", async ({ page, request }) => {
  await openTimeline(page);
  const [alpha, beta] = seeded.items;
  await dragOntoBar(page, beta!.id, alpha!.id);

  await expect
    .poll(async () => {
      const items = await laneItems(request, seeded.roadmapId, seeded.laneId);
      const parent = items.find((item) => item.id === alpha!.id);
      const child = parent?.children[0];
      return {
        topLevel: items.map((item) => item.title),
        child:
          child &&
          ({
            id: child.id,
            title: child.title,
            parentId: child.parentId,
            laneId: child.laneId,
            rank: child.rank,
            dates: [child.startDate, child.endDate],
          } as const),
      };
    })
    .toEqual({
      topLevel: ["Alpha"],
      child: {
        id: beta!.id,
        title: "Beta",
        parentId: alpha!.id,
        laneId: seeded.laneId,
        rank: 0,
        dates: [iso(monday), iso(addDays(monday, 27))],
      },
    });
});
