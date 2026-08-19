// What the item filter actually removes from the two chart projections.
//
// This is the one spec whose oracle is the DOM rather than the API, and the
// reason is that filtering never touches the server: the roadmap still holds
// every item afterwards, so "which rows are on screen" is client-only state —
// the same justification popover-dismiss.spec.ts gives for asserting that a
// dropdown is up. It is kept to presence and absence of the .bar / .child-bar /
// .wbs-row contracts the controllers themselves hit-test; never text, never
// styling, so a restyle cannot fail it.
//
// It exists because src/filter.test.ts pins the projection function and not the
// renderers' use of it. Cutting filterLane out of both views leaves every unit
// test and every other e2e test green, which makes the feature's whole promise
// — non-matches are gone, not dimmed — the least-guarded thing about it.

import { expect, test, type Page } from "@playwright/test";
import {
  addItem,
  addItemDependency,
  markFlagged,
  purgeRoadmap,
  seedRoadmap,
  setItemDates,
  type Seeded,
} from "./support";
import { pickFilter } from "./ui";

let seeded: Seeded;
let childId: number;

test.beforeEach(async ({ request }) => {
  seeded = await seedRoadmap(request, ["Alpha", "Beta"]);
  childId = await addItem(request, seeded.laneId, "Alpha Child", seeded.items[0]!.id);
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

// Call once per test. addInitScript registers a script that runs on every
// later navigation, so calling this twice would leave two of them writing
// roadie.view on the same page — a view a second call cannot reliably win.
// A test that needs the other projection is a second test.
async function open(page: Page, view: "timeline" | "wbs"): Promise<void> {
  await page.addInitScript((v) => localStorage.setItem("roadie.view", v), view);
  await page.goto(`/?roadmap=${seeded.roadmapId}`);
}

test("filtering removes non-matching bars from the timeline", async ({ page, request }) => {
  await markFlagged(request, seeded.items[1]!.id); // Beta
  await open(page, "timeline");
  await expect(bar(page, seeded.items[0]!.id)).toBeVisible();

  await pickFilter(page, /^Flagged \(/);
  await expect(bar(page, seeded.items[1]!.id)).toBeVisible();
  await expect(bar(page, seeded.items[0]!.id)).toHaveCount(0);
  await expect(bar(page, childId)).toHaveCount(0);

  // `f` clears and restores the recent filter without touching the model.
  await page.keyboard.press("f");
  await expect(bar(page, seeded.items[0]!.id)).toBeVisible();
  await expect(bar(page, childId)).toBeVisible();
  await page.keyboard.press("f");
  await expect(bar(page, seeded.items[0]!.id)).toHaveCount(0);
  await expect(bar(page, seeded.items[1]!.id)).toBeVisible();
});

test("filtering reconciles selection and can be cleared after its last match is removed", async ({
  page,
  request,
}) => {
  const alpha = seeded.items[0]!;
  const beta = seeded.items[1]!;
  await markFlagged(request, alpha.id);
  await open(page, "timeline");

  await bar(page, alpha.id).click();
  await bar(page, beta.id).click({ modifiers: ["Shift"] });
  await expect(page.locator("#panel")).toContainText("2 items selected");

  await pickFilter(page, /^Flagged \(/);
  await expect(bar(page, beta.id)).toHaveCount(0);
  await expect(page.locator("#panel .panel-title-input")).toHaveValue("Alpha");

  const saved = page.waitForResponse(
    (res) => res.url().endsWith(`/api/items/${alpha.id}`) && res.request().method() === "PATCH",
  );
  await page.locator("#panel .flag-btn").click();
  await saved;
  const roadmap = (await (await request.get(`/api/roadmaps/${seeded.roadmapId}`)).json()) as {
    lanes: { items: { id: number; flagged: boolean }[] }[];
  };
  expect(
    roadmap.lanes.flatMap((lane) => lane.items).find((item) => item.id === alpha.id)?.flagged,
  ).toBe(false);
  await expect(bar(page, alpha.id)).toHaveCount(0);
  await expect(page.locator("#panel .panel-title-input")).toHaveCount(0);

  await pickFilter(page, "Show all items");
  await expect(bar(page, alpha.id)).toBeVisible();
  await expect(bar(page, beta.id)).toBeVisible();
});

test("dependency conflicts filter both item endpoints in timeline and WBS", async ({
  page,
  request,
}) => {
  const alpha = seeded.items[0]!;
  const beta = seeded.items[1]!;
  const gamma = await addItem(request, seeded.laneId, "Gamma");
  await setItemDates(request, alpha.id, "2026-01-05", "2026-03-01");
  await addItemDependency(request, seeded.roadmapId, alpha.id, beta.id);
  await open(page, "timeline");

  await pickFilter(page, /^In conflict \(/);
  await expect(bar(page, alpha.id)).toBeVisible();
  await expect(bar(page, beta.id)).toBeVisible();
  await expect(bar(page, gamma)).toHaveCount(0);

  await page.keyboard.press("v");
  await expect(row(page, alpha.id)).toBeVisible();
  await expect(row(page, beta.id)).toBeVisible();
  await expect(row(page, gamma)).toHaveCount(0);
});

// The empty-result hint is about the filter, so it must not appear for a
// roadmap that simply has no items yet — the two states look identical from
// the drawn set alone.
test("a context with no items says nothing about filters", async ({ page, request }) => {
  const empty = await seedRoadmap(request, []);
  try {
    await page.addInitScript(() => localStorage.setItem("roadie.view", "timeline"));
    await page.goto(`/?roadmap=${empty.roadmapId}`);
    await expect(page.locator("#add-lane")).toBeVisible(); // the chart has rendered
    await expect(page.locator(".lanes-hint")).toHaveCount(0);
  } finally {
    await purgeRoadmap(request, empty.roadmapId);
  }
});

test("filtering removes non-matching rows from the WBS", async ({ page, request }) => {
  await markFlagged(request, seeded.items[1]!.id); // Beta
  await open(page, "wbs");
  await expect(row(page, seeded.items[0]!.id)).toBeVisible();

  await pickFilter(page, /^Flagged \(/);
  await expect(row(page, seeded.items[1]!.id)).toBeVisible();
  await expect(row(page, seeded.items[0]!.id)).toHaveCount(0);
  await expect(row(page, childId)).toHaveCount(0);
});

// The one non-match that survives, in both views: a parent is kept when a child
// matches, because a bare matching child would otherwise appear with nothing
// naming what it belongs to. One test per projection — see open().
test("a matching child keeps its non-matching parent on the timeline", async ({
  page,
  request,
}) => {
  await markFlagged(request, childId);
  await open(page, "timeline");

  await pickFilter(page, /^Flagged \(/);
  await expect(bar(page, childId)).toBeVisible();
  await expect(bar(page, seeded.items[0]!.id)).toBeVisible(); // the breadcrumb
  await expect(bar(page, seeded.items[1]!.id)).toHaveCount(0); // Beta matches nothing
});

test("a matching child keeps its non-matching parent in the WBS", async ({ page, request }) => {
  await markFlagged(request, childId);
  await open(page, "wbs");

  await pickFilter(page, /^Flagged \(/);
  await expect(row(page, childId)).toBeVisible();
  await expect(row(page, seeded.items[0]!.id)).toBeVisible();
  await expect(row(page, seeded.items[1]!.id)).toHaveCount(0);
});
