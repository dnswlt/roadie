// Timeline dependency focus is entirely client-side: toggling it changes no
// roadmap data, and whether its SVG and feedback badge fit the chart can only
// be answered after a browser has laid out the bars. That is the narrow reason
// this spec uses DOM assertions instead of the suite's usual API oracle.
//
// Graph membership, arrow direction and curve generation stay in the DOM-free
// deps-graph/deps-timeline-path tests. This smoke test pins only their wiring to
// real chart geometry — no screenshots, colors or exact path coordinates.

import { expect, test } from "@playwright/test";
import {
  addDependency,
  addItem,
  addItemDependency,
  addLane,
  addMilestone,
  purgeRoadmap,
  seedRoadmap,
  type Seeded,
} from "./support";

let seeded: Seeded;
let hiddenLaneId: number;
let hiddenPrerequisiteId: number;
let milestoneId: number;

test.beforeEach(async ({ request }) => {
  // The selected work sits far to the right of the hidden prerequisite, so
  // boot centers it at a substantial nonzero scroll offset.
  seeded = await seedRoadmap(request, ["Dependent", "Visible prerequisite", "Foldable"], {
    startDate: "2027-09-01",
    endDate: "2027-10-01",
  });
  hiddenLaneId = await addLane(request, seeded.roadmapId, "Hidden context");
  hiddenPrerequisiteId = await addItem(request, hiddenLaneId, "Hidden prerequisite");
  await addItem(request, seeded.laneId, "Folded child", seeded.items[2]!.id);
  milestoneId = await addMilestone(request, seeded.laneId, "Visible milestone", "2027-09-15");

  const dependentId = seeded.items[0]!.id;
  await addItemDependency(request, seeded.roadmapId, seeded.items[1]!.id, dependentId);
  await addItemDependency(request, seeded.roadmapId, hiddenPrerequisiteId, dependentId);
  await addDependency(
    request,
    seeded.roadmapId,
    { kind: "milestone", id: milestoneId },
    { kind: "item", id: seeded.items[2]!.id },
  );
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

test("keeps dependency feedback through a scrolled full render", async ({ page }) => {
  const dependentId = seeded.items[0]!.id;
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.addInitScript(
    ({ roadmapId, laneId }) => {
      localStorage.setItem("roadie.view", "timeline");
      localStorage.setItem(`roadie.hidden.${roadmapId}`, JSON.stringify([laneId]));
    },
    { roadmapId: seeded.roadmapId, laneId: hiddenLaneId },
  );
  await page.goto(`/?roadmap=${seeded.roadmapId}&item=${dependentId}`);

  const dependent = page.locator(`.bar[data-item-id="${dependentId}"]`);
  await expect(dependent).toBeVisible();
  await expect(page.locator(`.bar[data-item-id="${hiddenPrerequisiteId}"]`)).toHaveCount(0);
  const milestoneLabel = page.locator(
    `.milestone[data-milestone-id="${milestoneId}"] .milestone-label`,
  );
  await expect(milestoneLabel.locator(".bar-dep")).toBeVisible();
  expect(
    await milestoneLabel.locator(":scope > *").evaluateAll((children) =>
      children.map((child) => child.getAttribute("class")),
    ),
  ).toEqual(["bar-dep", "milestone-title"]);

  const toggle = page.locator("#deps-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".timeline-dep-edge")).toHaveCount(1);
  await expect(page.locator(".timeline-dep-arrow-guide")).toHaveAttribute(
    "marker-end",
    "url(#timeline-dep-arrow)",
  );
  expect(
    await page.locator(".timeline-deps-svg > g").evaluateAll((layers) =>
      layers.map((layer) => layer.getAttribute("class")),
    ),
  ).toEqual(["timeline-dep-edges", "timeline-dep-arrows"]);

  const note = page.locator(".timeline-deps-note");
  await expect(note).toHaveText("1 connection hidden by the current view");
  const chart = page.locator("#chart");
  const chartBoxBefore = await chart.boundingBox();
  expect(chartBoxBefore).not.toBeNull();
  expect(await chart.evaluate((el) => el.scrollLeft)).toBeGreaterThan(chartBoxBefore!.width);

  // Folding an unrelated parent causes a full render. Viewport clamping used
  // to run while replaceChildren had reset scroll to zero, so restoring this
  // scroll stranded the rebuilt badge off-screen.
  await page.locator("#fold-all").click();
  await expect(page.locator(".timeline-dep-edge")).toHaveCount(1);
  await expect(note).toHaveText("1 connection hidden by the current view");
  const [noteBox, chartBox] = await Promise.all([note.boundingBox(), chart.boundingBox()]);
  expect(noteBox).not.toBeNull();
  expect(chartBox).not.toBeNull();
  expect(noteBox!.x).toBeGreaterThanOrEqual(chartBox!.x);
  expect(noteBox!.x + noteBox!.width).toBeLessThanOrEqual(chartBox!.x + chartBox!.width);

  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".timeline-deps-overlay")).toHaveCount(1);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".timeline-deps-overlay")).toHaveCount(0);
});
