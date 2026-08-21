// Keyboard tests for the edit panel. As in the gesture specs, the browser is
// used only for the interaction seam and the API is the persistence oracle:
//
//   seed via API  →  act via keyboard  →  assert via API  →  purge.
//
// The selected class is the one necessary DOM assertion here. Selection is
// client-only state, so the server cannot tell us whether Escape retained it.

import { expect, test, type Page } from "@playwright/test";
import { laneItems, purgeRoadmap, seedRoadmap, type Seeded } from "./support";

let seeded: Seeded;

test.beforeEach(async ({ request }) => {
  seeded = await seedRoadmap(request, ["Alpha"]);
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

function bar(page: Page) {
  return page.locator(`.bar[data-item-id="${seeded.items[0]!.id}"]`);
}

function block(page: Page) {
  return page.locator(`.block[data-item-id="${seeded.items[0]!.id}"]`);
}

test("Escape saves a description edit and retains the item selection", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("roadie.view", "timeline"));
  await page.goto(`/?roadmap=${seeded.roadmapId}`);

  await bar(page).click();
  const description = page.locator(".panel-field textarea");
  await expect(description).toBeVisible();

  await description.fill("Saved by Escape");
  await description.press("Escape");

  await expect(description).not.toBeFocused();
  await expect(block(page)).toHaveClass(/\bselected\b/);
  await expect
    .poll(async () => (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!.description)
    .toBe("Saved by Escape");
});

test("Tab from a changed title lands in the description", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("roadie.view", "timeline"));
  await page.goto(`/?roadmap=${seeded.roadmapId}&item=${seeded.items[0]!.id}`);

  const title = page.locator("#panel .panel-title-input");
  const description = page.locator("#panel textarea");
  await title.fill("Renamed by Tab");

  const saved = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/items/${seeded.items[0]!.id}`) &&
      res.request().method() === "PATCH",
  );
  await title.press("Tab");
  await saved;

  await expect(description).toBeFocused();
});
