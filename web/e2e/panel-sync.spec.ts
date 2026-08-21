// Regression coverage for panel redraws: committed changes should appear at
// once, structural changes should rebuild the rail, and an unrelated live edit
// must not erase text someone is still typing.

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { laneItems, purgeRoadmap, seedRoadmap, type Seeded } from "./support";

let seeded: Seeded;

test.beforeEach(async ({ request }) => {
  seeded = await seedRoadmap(request, ["Alpha", "Beta"]);
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

function bar(page: Page, itemId: number) {
  return page.locator(`.bar[data-item-id="${itemId}"]`);
}

async function openTimeline(page: Page, itemId?: number): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("roadie.view", "timeline"));
  const selected = itemId === undefined ? "" : `&item=${itemId}`;
  await page.goto(`/?roadmap=${seeded.roadmapId}${selected}`);
  await expect(bar(page, seeded.items[0]!.id)).toBeVisible();
}

async function dragOntoBar(page: Page, itemId: number, targetId: number): Promise<void> {
  const source = (await bar(page, itemId).boundingBox())!;
  const target = (await bar(page, targetId).boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  // Keep this structural gesture date-neutral, as in timeline-drag.spec.ts.
  await page.keyboard.down("Shift");
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
}

async function itemState(
  request: APIRequestContext,
  itemId: number,
): Promise<{ description: string; flagged: boolean } | undefined> {
  const res = await request.get(`/api/roadmaps/${seeded.roadmapId}`);
  expect(res.ok(), `GET roadmap -> ${res.status()}`).toBe(true);
  const rm = (await res.json()) as {
    lanes: { items: { id: number; description: string; flagged: boolean }[] }[];
  };
  const item = rm.lanes.flatMap((lane) => lane.items).find((candidate) => candidate.id === itemId);
  return item ? { description: item.description, flagged: item.flagged } : undefined;
}

test("multi-selection priority reflects the value just applied", async ({ page }) => {
  await openTimeline(page);
  const [alpha, beta] = seeded.items;
  await bar(page, alpha!.id).click();
  await bar(page, beta!.id).click({ modifiers: ["Shift"] });
  await expect(page.locator("#panel")).toContainText("2 items selected");

  const p2 = page.locator("#panel .prio-chip", { hasText: "P2" });
  await p2.click();

  // The optimistic model update re-renders with the same selection, so the
  // newly applied common value must be visible immediately.
  await expect(p2).toHaveClass(/\bactive\b/);
  await expect(p2).toHaveAttribute("aria-pressed", "true");
});

test("adding a schedule adds period controls to the selected item's form", async ({ page }) => {
  await openTimeline(page, seeded.items[0]!.id);
  const startPeriod = page.locator('#panel select[aria-label="Start period"]');
  await expect(startPeriod).toHaveCount(0);

  await page.locator("#rm-actions").click();
  await page.locator("#rm-schedule").click();
  await page.locator(".schedule-editor").fill("2026-01-01 2026-01-31 Sprint 1");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#dialog")).not.toBeVisible();

  // The schedule changes the form's shape, not merely the selected item's
  // date values, so its period row must appear without selecting away and back.
  await expect(startPeriod).toHaveCount(1);
  await expect(startPeriod.locator("option", { hasText: "Sprint 1" })).toHaveCount(1);
});

test("nesting the selected item rebuilds its top-level-only rail chrome", async ({
  page,
  request,
}) => {
  const [alpha, beta] = seeded.items;
  await openTimeline(page, beta!.id);
  await expect(page.locator("#panel .panel-kind")).toHaveText("Item");
  await expect(page.getByRole("button", { name: "Add Child", exact: true })).toBeVisible();

  await dragOntoBar(page, beta!.id, alpha!.id);
  await expect
    .poll(async () => (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!.children[0]?.id)
    .toBe(beta!.id);

  // A child has different header text and cannot itself accept children. Both
  // pieces are structural and must be rebuilt when parentId changes.
  await expect(page.locator("#panel .panel-kind")).toHaveText("Child item");
  await expect(page.getByRole("button", { name: "Add Child", exact: true })).toHaveCount(0);
});

test("an external flag edit does not erase a local description draft", async ({
  page,
  request,
}) => {
  const itemId = seeded.items[0]!.id;
  const eventsConnected = page.waitForResponse(
    (res) => res.url().endsWith(`/api/roadmaps/${seeded.roadmapId}/events`) && res.status() === 200,
  );
  await openTimeline(page, itemId);
  await eventsConnected;

  const description = page.locator("#panel textarea");
  await description.fill("Person B's unfinished description");
  await expect(description).toBeFocused();

  // The API request has no browser tab's X-Client-Id, so the open page sees it
  // as somebody else's edit through the roadmap event stream.
  const external = await request.patch(`/api/items/${itemId}`, { data: { flagged: true } });
  expect(external.ok(), `PATCH item flag -> ${external.status()}`).toBe(true);
  await expect(page.locator("#stale-pill")).toBeVisible();
  await expect(description).toHaveValue("Person B's unfinished description");

  const saved = page.waitForResponse(
    (res) => res.url().endsWith(`/api/items/${itemId}`) && res.request().method() === "PATCH",
  );
  await description.press("Escape");
  await saved;

  await expect
    .poll(() => itemState(request, itemId))
    .toEqual({ description: "Person B's unfinished description", flagged: true });
});
