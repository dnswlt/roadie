// Keyboard reordering (reorder.ts, bound to Alt+Arrow in keys.ts). The same
// narrow contract the gesture specs follow:
//
//   seed via API  →  act via keyboard  →  assert via API  →  purge.
//
// stepRank is pinned DOM-free in src/reorder.test.ts. What only a browser can
// show is that the keystroke reaches it at all: that the binding survives the
// modifier match, that it acts on the item the user selected, and that it
// works the same way in both views — which is the feature's whole claim.

import { expect, test, type Page } from "@playwright/test";
import {
  addItem,
  laneItems,
  markFlagged,
  purgeRoadmap,
  seedRoadmap,
  type ItemNode,
  type Seeded,
} from "./support";
import { pickFilter } from "./ui";

let seeded: Seeded;

test.beforeEach(async ({ request }) => {
  seeded = await seedRoadmap(request, ["Alpha", "Beta", "Gamma", "Delta"]);
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

function bar(page: Page, itemId: number) {
  return page.locator(`.bar[data-item-id="${itemId}"], .child-bar[data-item-id="${itemId}"]`);
}

function row(page: Page, itemId: number) {
  return page.locator(`.wbs-row[data-item-id="${itemId}"]`);
}

// Call once per test: addInitScript runs on every later navigation, so a
// second call would leave two scripts writing roadie.view (wbs-drag.spec.ts).
async function open(page: Page, view: "timeline" | "wbs", itemId?: number): Promise<void> {
  await page.addInitScript((v) => localStorage.setItem("roadie.view", v), view);
  const item = itemId === undefined ? "" : `&item=${itemId}`;
  await page.goto(`/?roadmap=${seeded.roadmapId}${item}`);
}

async function titles(request: Parameters<typeof laneItems>[0]): Promise<string[]> {
  return (await laneItems(request, seeded.roadmapId, seeded.laneId)).map((i) => i.title);
}

async function childTitles(
  request: Parameters<typeof laneItems>[0],
  parentId: number,
): Promise<string[]> {
  const items = await laneItems(request, seeded.roadmapId, seeded.laneId);
  return (items.find((i: ItemNode) => i.id === parentId)?.children ?? []).map((c) => c.title);
}

test("Alt+Up moves the selected bar above its previous sibling", async ({ page, request }) => {
  await open(page, "timeline");
  const beta = seeded.items[1]!;
  await bar(page, beta.id).click();

  await page.keyboard.press("Alt+ArrowUp");

  await expect.poll(() => titles(request)).toEqual(["Beta", "Alpha", "Gamma", "Delta"]);
});

test("Alt+Down moves the selected WBS row below the next one", async ({ page, request }) => {
  await open(page, "wbs");
  const beta = seeded.items[1]!;
  await row(page, beta.id).click();

  await page.keyboard.press("Alt+ArrowDown");

  await expect.poll(() => titles(request)).toEqual(["Alpha", "Gamma", "Beta", "Delta"]);
});

// The invariant worth a browser: a child is ranked among its siblings, so the
// first one has nowhere to go up and stays put rather than escaping its parent
// or wrapping to the end. Three children make that silence observable: the
// second press is dropped while a move is in flight, so anything the first
// press did would still be on the board — a wrap would leave First last, and
// an escape would leave two children, not three.
test("a child moves within its parent and cannot leave it", async ({ page, request }) => {
  const alpha = seeded.items[0]!;
  const first = await addItem(request, seeded.laneId, "First child", alpha.id);
  await addItem(request, seeded.laneId, "Second child", alpha.id);
  await addItem(request, seeded.laneId, "Third child", alpha.id);
  await open(page, "wbs");
  await row(page, first).click();

  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Alt+ArrowDown");

  await expect
    .poll(() => childTitles(request, alpha.id))
    .toEqual(["Second child", "First child", "Third child"]);
  expect(await titles(request)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
});

// Moving pauses under a filter for the same reason a drag does: the rows on
// screen are no longer the list being renumbered. The refusal toast is what
// makes the silence observable — without it, "did nothing" and "has not
// answered yet" are the same picture, and the test would pass either way.
// Presence only, never its text: dnd.ts raises the same message.
test("an active filter blocks the move", async ({ page, request }) => {
  const beta = seeded.items[1]!;
  await markFlagged(request, beta.id);
  await open(page, "timeline");
  await pickFilter(page, /^Flagged \(/);
  await bar(page, beta.id).click();

  await page.keyboard.press("Alt+ArrowDown");

  await expect(page.locator("#toasts .toast")).toBeVisible();
  expect(await titles(request)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
});

// Following a moved row is not the same question as putting it in the browser
// viewport: the time axis and the active-item profile are pinned over the top
// of the scroller, so a row scrolled flush to its edge is on screen and still
// unreadable. Pressing until the row has to cross that edge is what tells the
// two apart — and the scroll assertion at the end keeps the test honest, since
// a chart that never scrolled would pass every check above it for free.
test("a row scrolled up stays clear of the pinned bands", async ({ page, request }) => {
  for (let i = 0; i < 10; i++) await addItem(request, seeded.laneId, `Filler ${i}`);
  const last = seeded.items[seeded.items.length - 1]!;
  await page.setViewportSize({ width: 1000, height: 400 });
  await open(page, "timeline", last.id);

  const chart = page.locator("#chart");
  const selected = page.locator(".block.selected");
  await expect(selected).toBeVisible();
  const scrolledAtStart = await chart.evaluate((el) => el.scrollTop);
  let previousY = (await selected.boundingBox())!.y;

  // The seeded items rank ahead of the fillers, so the selected one starts at
  // rank 3 and has room to climb.
  for (let rank = 2; rank >= 0; rank--) {
    await page.keyboard.press("Alt+ArrowUp");
    await expect
      .poll(async () =>
        (await laneItems(request, seeded.roadmapId, seeded.laneId)).findIndex(
          (i) => i.id === last.id,
        ),
      )
      .toBe(rank);

    const pinned = await page.evaluate(() => {
      const chartEl = document.getElementById("chart")!;
      const top = chartEl.getBoundingClientRect().top;
      let covered = top;
      for (const el of chartEl.querySelectorAll(".thead, .activity-row")) {
        covered = Math.max(covered, el.getBoundingClientRect().bottom);
      }
      return { covered, bottom: chartEl.getBoundingClientRect().bottom };
    });
    const box = (await selected.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(pinned.covered - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(pinned.bottom + 1);
    // Moving up must never push the row further down the screen, which is
    // what scrolling to the far edge instead of the near one looks like.
    expect(box.y).toBeLessThanOrEqual(previousY + 1);
    previousY = box.y;
  }

  expect(await chart.evaluate((el) => el.scrollTop)).toBeLessThan(scrolledAtStart);
});

// "Nearest" means the viewport holds still while the row it follows is still
// readable. This is the case a full re-render gets wrong for free: the rebuilt
// scroller starts at the top, so arithmetic that trusts it thinks every row is
// below the fold and hauls the chart a page at a time.
test("a move that needs no scrolling leaves the viewport alone", async ({ page, request }) => {
  for (let i = 0; i < 10; i++) await addItem(request, seeded.laneId, `Filler ${i}`);
  const all = await laneItems(request, seeded.roadmapId, seeded.laneId);
  const centred = all[7]!;
  const above = all[6]!;
  await page.setViewportSize({ width: 1000, height: 400 });
  // Opening on a mid-list item leaves the chart scrolled, which is the state
  // the bug needed: at scroll zero every row is where the arithmetic expects.
  await open(page, "timeline", centred.id);
  const chart = page.locator("#chart");
  await expect(page.locator(".block.selected")).toBeVisible();
  expect(await chart.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // A second selection, made the way a user makes it, moving one place into
  // the room the first one occupies — nothing needs to scroll.
  await bar(page, above.id).click();
  const before = await chart.evaluate((el) => el.scrollTop);
  await page.keyboard.press("Alt+ArrowDown");
  await expect
    .poll(async () =>
      (await laneItems(request, seeded.roadmapId, seeded.laneId)).findIndex(
        (i) => i.id === above.id,
      ),
    )
    .toBe(7);

  expect(await chart.evaluate((el) => el.scrollTop)).toBeCloseTo(before, 0);
});

// A vertical reorder changes rank, not dates. A long bar may already cross
// the whole readable chart while its leading edge is behind the pinned rail;
// following that edge would pan the timeline away from the user's date range.
test("moving a long visible bar keeps the horizontal viewport", async ({ page, request }) => {
  const beta = seeded.items[1]!;
  const response = await request.patch(`/api/items/${beta.id}`, {
    data: { endDate: "2028-01-05" },
  });
  expect(response.ok()).toBe(true);

  await page.setViewportSize({ width: 1280, height: 600 });
  await open(page, "timeline", beta.id);
  const chart = page.locator("#chart");
  await expect(page.locator(`.block.selected[data-item-id="${beta.id}"]`)).toBeVisible();
  const before = await chart.evaluate((el) => {
    el.scrollLeft = el.scrollWidth / 4;
    return el.scrollLeft;
  });
  const band = await page.evaluate((id) => {
    const chartEl = document.getElementById("chart")!;
    const barEl = chartEl.querySelector<HTMLElement>(`.block[data-item-id="${id}"]`)!;
    const railEl = chartEl.querySelector<HTMLElement>(".lane-label")!;
    return {
      left: railEl.getBoundingClientRect().right,
      right: chartEl.getBoundingClientRect().right,
      barLeft: barEl.getBoundingClientRect().left,
      barRight: barEl.getBoundingClientRect().right,
    };
  }, beta.id);
  expect(band.barLeft).toBeLessThan(band.left);
  expect(band.barRight).toBeGreaterThan(band.right);

  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(async () => (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]?.id)
    .toBe(beta.id);
  const after = await chart.evaluate((el) => el.scrollLeft);
  expect(Math.abs(after - before) / (band.right - band.left)).toBeLessThan(0.05);
});

// The general form of the rule the test above pins for a long bar: a rank
// change says nothing about dates, so the date viewport is never the move's
// to take — not even when the row it follows has been scrolled clean off the
// side and following it horizontally would be the only way to show it.
test("a vertical move never pans the timeline", async ({ page, request }) => {
  const beta = seeded.items[1]!;
  await page.setViewportSize({ width: 1000, height: 600 });
  await open(page, "timeline", beta.id);
  await expect(page.locator(`.block.selected[data-item-id="${beta.id}"]`)).toBeVisible();

  // Park the timeline at its far right, which leaves the selected bar's dates
  // off the left edge entirely.
  const before = await page.locator("#chart").evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    return el.scrollLeft;
  });
  expect(before).toBeGreaterThan(0);
  const box = await page.locator(`.block[data-item-id="${beta.id}"]`).boundingBox();
  expect(box!.x + box!.width).toBeLessThan(0);

  await page.keyboard.press("Alt+ArrowUp");
  await expect
    .poll(async () => (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]?.id)
    .toBe(beta.id);

  expect(await page.locator("#chart").evaluate((el) => el.scrollLeft)).toBeCloseTo(before, 0);
});
