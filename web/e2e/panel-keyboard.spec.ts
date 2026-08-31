// Keyboard tests for the edit panel. As in the gesture specs, the browser is
// used only for the interaction seam and the API is the persistence oracle:
//
//   seed via API  →  act via keyboard  →  assert via API  →  purge.
//
// Selection, focus and invalid drafts are client-only state; DOM assertions
// pin what the server cannot tell us about keyboard editing.

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

// Length rules are unit-tested; the browser pins preservation of a rejected
// draft across commit gestures and the ability to correct and save it.
for (const key of ["Enter", "Tab"]) {
  test(`a rejected label stays editable after ${key}`, async ({ page, request }) => {
    const itemId = seeded.items[0]!.id;
    await page.goto(`/?roadmap=${seeded.roadmapId}&item=${itemId}`);
    const input = page.getByRole("combobox", { name: "Add label", exact: true });
    const error = page.locator("#label-input-error");
    const draft = "a".repeat(65);
    await input.fill(draft);
    await input.press(key);

    await expect(input).toHaveValue(draft);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(error).toBeVisible();
    expect((await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!.labels).toEqual([]);

    await input.fill("Ready");
    await expect(input).not.toHaveAttribute("aria-invalid", "true");
    await expect(error).toBeHidden();
    await input.press("Enter");

    await expect(input).toHaveValue("");
    await expect
      .poll(async () => (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!.labels)
      .toEqual(["Ready"]);
  });
}
