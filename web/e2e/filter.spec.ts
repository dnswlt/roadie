// What the label/flag filter actually removes from the two chart projections.
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
import { addItem, markFlagged, purgeRoadmap, seedRoadmap, type Seeded } from "./support";
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

  // Clearing restores every row: the filter is a view, and it left the model
  // alone (the afterEach purge would fail loudly if it had not).
  await pickFilter(page, "Show all items");
  await expect(bar(page, seeded.items[0]!.id)).toBeVisible();
  await expect(bar(page, childId)).toBeVisible();
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
