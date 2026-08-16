// The Roadie half of reconciliation is a query-independent inbox: every item
// without a Jira-shaped reference, in roadmap order. These checks stay at the
// DOM boundary because the pure projection is covered in recon-diff.test.ts;
// what matters here is that the second list is reachable and feeds the shared
// item selection/edit-panel flow.

import { expect, test } from "@playwright/test";
import { laneItems, purgeRoadmap, seedRoadmap, type Seeded } from "./support";

let seeded: Seeded;

test.beforeEach(async ({ request, page }) => {
  seeded = await seedRoadmap(request, ["Linked parent", "Unlinked sibling"]);
  const parent = seeded.items[0]!;
  const linked = await request.patch(`/api/items/${parent.id}`, {
    data: { description: "https://jira.example.test/browse/ROAD-1" },
  });
  expect(linked.ok(), `PATCH item -> ${linked.status()}`).toBe(true);
  const child = await request.post(`/api/lanes/${seeded.laneId}/items`, {
    data: {
      title: "Unlinked child",
      description: "",
      startDate: "2026-01-05",
      endDate: "2026-02-01",
      parentId: parent.id,
    },
  });
  expect(child.ok(), `POST child -> ${child.status()}`).toBe(true);

  await page.goto(`/?roadmap=${seeded.roadmapId}`);
  await page.locator("#view-recon").click();
  await page.getByRole("button", { name: /Roadie items/ }).click();
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

test("lists unreferenced parents and children with their roadmap context", async ({ page }) => {
  const rows = page.locator(".recon-roadie-item");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Unlinked child");
  await expect(rows.nth(0)).toContainText("Lane › Linked parent");
  await expect(rows.nth(1)).toContainText("Unlinked sibling");
  await expect(rows.nth(1).locator(".recon-roadie-context")).toHaveText("Lane");
  await expect(page.locator(".recon-input")).toHaveCount(0);
});

test("can narrow the Roadie list to top-level items", async ({ page }) => {
  const chip = page.locator(".recon-filter-chip");
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await chip.click();

  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".recon-roadie-item")).toHaveCount(1);
  await expect(page.locator(".recon-roadie-item")).toContainText("Unlinked sibling");
  await expect(page.locator(".recon-roadie-item")).not.toContainText("Unlinked child");
});

test("opens an item in the edit panel and carries its selection to WBS", async ({ page }) => {
  await page
    .locator(".recon-roadie-item", { hasText: "Unlinked child" })
    .locator(".recon-roadie-open")
    .click();
  await expect(page.locator("#panel .panel-title-input")).toHaveValue("Unlinked child");

  await page.locator("#view-wbs").click();
  await expect(page.locator(".wbs-row.selected")).toContainText("Unlinked child");
});

// The selected class is client-only state, asserted here for the same reason
// panel-keyboard.spec.ts asserts it: the server cannot be asked what the list
// is currently marking. Recon has no selection projection, so a selection-only
// change has to reach it as a rebuild.
test("stops marking a row once the selection is cleared", async ({ page }) => {
  const row = page.locator(".recon-roadie-item", { hasText: "Unlinked child" });
  await row.locator(".recon-roadie-open").click();
  await expect(row).toHaveClass(/\bselected\b/);

  await page.locator('#panel button[title="Clear selection"]').click();
  await expect(row).not.toHaveClass(/\bselected\b/);
});

test("links an item by choosing from Jira results", async ({ page, request }) => {
  const sibling = page.locator(".recon-roadie-item", { hasText: "Unlinked sibling" });
  await sibling.locator(".recon-roadie-link").click();

  const mode = page.locator(".recon-link-mode");
  await expect(mode).toContainText("Choose a Jira issue to link to Unlinked sibling");
  await expect(mode.getByRole("button", { name: "Cancel" })).toBeVisible();

  await page.locator(".recon-input").fill("payment");
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator(".recon-issue").first()).toBeVisible();
  await page.locator(".recon-issue-link-target").first().click();

  await expect(page.locator(".recon-link-mode")).toHaveCount(0);
  await expect(page.locator(".recon-roadie-item", { hasText: "Unlinked sibling" })).toHaveCount(0);
  const items = await laneItems(request, seeded.roadmapId, seeded.laneId);
  expect(items[1]!.description).toBe("http://localhost:4013/browse/PAY-101");
});

test("can cancel linking without choosing an issue", async ({ page }) => {
  const link = () =>
    page
      .locator(".recon-roadie-item", { hasText: "Unlinked child" })
      .locator(".recon-roadie-link")
      .click();
  await link();
  await expect(page.locator(".recon-link-mode")).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".recon-link-mode")).toHaveCount(0);
  await expect(page.locator(".recon-roadie-item", { hasText: "Unlinked child" })).toBeVisible();

  await link();
  await page.keyboard.press("Escape");
  await expect(page.locator(".recon-link-mode")).toHaveCount(0);
  await expect(page.locator(".recon-roadie-item", { hasText: "Unlinked child" })).toBeVisible();
});

test("keeps linking mode across a quick look at WBS", async ({ page }) => {
  await page
    .locator(".recon-roadie-item", { hasText: "Unlinked child" })
    .locator(".recon-roadie-link")
    .click();
  await expect(page.locator(".recon-link-mode")).toBeVisible();

  await page.locator("#view-wbs").click();
  await expect(page.locator(".wbs-row.selected")).toContainText("Unlinked child");
  // Escape belongs to WBS while the linking UI is off-screen.
  await page.keyboard.press("Escape");
  await page.locator("#view-recon").click();

  await expect(page.locator(".recon-link-mode")).toContainText("Unlinked child");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
});
