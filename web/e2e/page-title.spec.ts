// The document title is browser chrome rather than rendered page content. Its
// two live transitions — opening and renaming a roadmap — therefore need a
// browser assertion rather than a DOM-free unit test.

import { expect, test } from "@playwright/test";
import { purgeRoadmap, seedRoadmap } from "./support";

test("the page title follows the current roadmap and its name", async ({ page, request }) => {
  const seeded = await seedRoadmap(request, []);
  try {
    await page.goto(`/?roadmap=${seeded.roadmapId}`);
    await expect(page).toHaveTitle(`${seeded.roadmapName} · Roadie`);

    await page.locator("#rm-actions").click();
    await page.locator("#rm-rename").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("Renamed roadmap");
    const saved = page.waitForResponse(
      (res) =>
        res.url().endsWith(`/api/roadmaps/${seeded.roadmapId}`) &&
        res.request().method() === "PATCH",
    );
    await dialog.getByRole("button", { name: "Rename", exact: true }).click();
    await saved;

    await expect(page).toHaveTitle("Renamed roadmap · Roadie");
  } finally {
    await purgeRoadmap(request, seeded.roadmapId);
  }
});
