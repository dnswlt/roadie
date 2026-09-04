// What the filter actually removes from the two chart projections.
//
// This is the one spec whose oracle is the DOM rather than the API, and the
// reason is that filtering never touches the server: the roadmap still holds
// every entity afterwards, so "which rows are on screen" is client-only state —
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
  addMilestone,
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

function milestone(page: Page, milestoneId: number) {
  return page.locator(
    `.milestone[data-milestone-id="${milestoneId}"], .wbs-milestone[data-milestone-id="${milestoneId}"]`,
  );
}

// Call once per test. addInitScript registers a script that runs on every
// later navigation, so calling this twice would leave two of them writing
// roadie.view on the same page — a view a second call cannot reliably win.
// A test that needs the other projection is a second test.
async function open(page: Page, view: "timeline" | "wbs"): Promise<void> {
  await page.addInitScript((v) => localStorage.setItem("roadie.view", v), view);
  await page.goto(`/?roadmap=${seeded.roadmapId}`);
  // The document can finish loading before the roadmap request does.
  const first = seeded.items[0]!.id;
  await expect(view === "timeline" ? bar(page, first) : row(page, first)).toBeVisible();
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

test("label filters remove milestones in both views and inversion restores them", async ({
  page,
  request,
}) => {
  const alpha = seeded.items[0]!.id;
  const ms = await addMilestone(request, seeded.laneId, "Release", "2026-02-15");
  const labelled = await request.patch(`/api/items/${alpha}`, {
    data: { labels: ["@teamX"] },
  });
  expect(labelled.ok()).toBe(true);
  await open(page, "timeline");
  await expect(milestone(page, ms)).toBeVisible();

  await pickFilter(page, "@teamX");
  await expect(bar(page, alpha)).toBeVisible();
  await expect(milestone(page, ms)).toHaveCount(0);

  await page.keyboard.press("v");
  await expect(row(page, alpha)).toBeVisible();
  await expect(milestone(page, ms)).toHaveCount(0);

  await pickFilter(page, "Invert filter");
  await expect(milestone(page, ms)).toBeVisible();
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

  await pickFilter(page, "Show all");
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
    await page.locator("#filter-menu").click();
    const menu = page.locator("#filter-pop");
    await expect(menu).toContainText("No labels, flags, at-risk items or dependency conflicts to filter by yet.");
    await expect(menu.getByRole("button")).toHaveCount(0);
    await expect(menu.locator(".menu-sep")).toHaveCount(0);
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

for (const view of ["timeline", "wbs"] as const) {
  test(`inverting label picks shows unclassified items in ${view}`, async ({ page, request }) => {
    const alpha = seeded.items[0]!.id;
    const beta = seeded.items[1]!.id;
    const gamma = await addItem(request, seeded.laneId, "Gamma");
    for (const [id, label] of [[alpha, "needs-refinement"], [beta, "refined"], [gamma, "@team"]] as const) {
      const res = await request.patch(`/api/items/${id}`, { data: { labels: [label] } });
      expect(res.ok()).toBe(true);
    }
    await open(page, view);
    const entity = (id: number) => view === "timeline" ? bar(page, id) : row(page, id);

    await page.locator("#filter-menu").click();
    const menu = page.locator("#filter-pop");
    const invert = menu.getByRole("button", { name: "Invert filter", exact: true });
    await expect(invert).toBeDisabled();
    await menu.getByRole("button", { name: "needs-refinement", exact: true }).click();
    await menu.getByRole("button", { name: "refined", exact: true }).click();
    await invert.click();
    await expect(invert).toHaveAttribute("aria-pressed", "true");
    await page.locator("#filter-menu").click();

    await expect(entity(alpha)).toBeVisible(); // the child's breadcrumb
    await expect(entity(childId)).toBeVisible(); // no labels
    await expect(entity(gamma)).toBeVisible(); // unrelated label
    await expect(entity(beta)).toHaveCount(0);
    await expect(page.locator("#filter-menu")).toHaveAttribute("title", /without any of: needs-refinement, refined/);

    await page.keyboard.press("f");
    await expect(entity(beta)).toBeVisible();
    await page.keyboard.press("f");
    await expect(entity(beta)).toHaveCount(0);

    await pickFilter(page, "Show all");
    await expect(entity(beta)).toBeVisible();
    await page.locator("#filter-menu").click();
    await expect(invert).toBeDisabled();
    await expect(invert).toHaveAttribute("aria-pressed", "false");
  });
}

for (const kind of ["signal", "label"] as const) {
  test(`an active ${kind} remains invertible after its last use is removed`, async ({ page, request }) => {
    const alpha = seeded.items[0]!.id;
    const data = kind === "signal" ? { flagged: true } : { labels: ["refined"] };
    const res = await request.patch(`/api/items/${alpha}`, { data });
    expect(res.ok()).toBe(true);
    await open(page, "timeline");
    await bar(page, alpha).click();
    await pickFilter(page, kind === "signal" ? "Flagged (1)" : "refined");
    const saved = page.waitForResponse(
      res => res.url().endsWith(`/api/items/${alpha}`) && res.request().method() === "PATCH",
    );
    await page.locator(kind === "signal" ? "#panel .flag-btn" : "#panel .label-x").click();
    await saved;
    await expect(bar(page, alpha)).toHaveCount(0);

    await page.locator("#filter-menu").click();
    const name = kind === "signal" ? "Flagged (0)" : "refined";
    await expect(page.locator("#filter-pop").getByRole("button", { name, exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Invert filter", exact: true }).click();
    await page.locator("#filter-menu").click();
    await expect(bar(page, alpha)).toBeVisible();
    await expect(bar(page, seeded.items[1]!.id)).toBeVisible();
    await expect(bar(page, childId)).toBeVisible();
  });
}

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
