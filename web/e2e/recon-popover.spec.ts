// Popover exclusivity inside the reconciliation view, which has two of its own
// (popover.ts, and see popover-dismiss.spec.ts for the same property across the
// rest of the app). Same justification for asserting on the DOM: whether a
// dropdown is on screen is client-only state the server cannot be asked about.
//
// The regression these exist for is specific to a view that re-renders
// wholesale. Dismissal runs in the capture phase, before the handler of
// whatever was clicked — so when the Saved menu's onDismiss repainted the whole
// view, clicking an issue's + detached that issue's row before its own handler
// ran, and the link picker was appended to a node no longer in the document:
// nothing appeared. onDismiss now removes only its own menu.
//
// Needs the deployment tracker connection, which playwright.config.ts supplies
// with the dev/jira mock: without it the view is unreachable, its button hidden.

import { expect, test, type Page } from "@playwright/test";
import { purgeRoadmap, seedRoadmap, type Seeded } from "./support";

let seeded: Seeded;

const savedMenu = (page: Page) => page.locator(".recon-fav-menu");
const linkPicker = (page: Page) => page.locator(".recon-link-pop");

test.beforeEach(async ({ request, page }) => {
  seeded = await seedRoadmap(request, ["Alpha"]);
  // A favourite, so the Saved button has something to drop down. The mock's
  // whole "JQL" is a substring match over issue summaries (dev/jira), so this
  // is a term its fixtures actually contain rather than real JQL.
  const res = await request.post(`/api/roadmaps/${seeded.roadmapId}/tracker-queries`, {
    data: { name: "Payments", query: "payment" },
  });
  expect(res.ok(), `POST tracker-queries -> ${res.status()}`).toBe(true);

  await page.goto(`/?roadmap=${seeded.roadmapId}`);
  await page.locator("#view-recon").click();
  await page.locator(".recon-input").fill("payment");
  await page.getByRole("button", { name: "Run" }).click();
  // Results are what carry the + buttons these tests click.
  await expect(page.locator(".recon-issue").first()).toBeVisible();
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

// The P2: the Saved menu is dismissed by the capture listener, and the picker
// must still open on the row that was clicked.
test("opening an issue's link picker while Saved is open dismisses Saved and still opens", async ({
  page,
}) => {
  await page.locator(".recon-fav-btn").click();
  await expect(savedMenu(page)).toBeVisible();

  await page.locator(".recon-issue-add").first().click();
  await expect(savedMenu(page)).toHaveCount(0);
  await expect(linkPicker(page)).toBeVisible();
});

test("opening Saved dismisses an issue's link picker", async ({ page }) => {
  await page.locator(".recon-issue-add").first().click();
  await expect(linkPicker(page)).toBeVisible();

  await page.locator(".recon-fav-btn").click();
  await expect(savedMenu(page)).toBeVisible();
  await expect(linkPicker(page)).toHaveCount(0);
});

// Both Recon popovers against the rest of the app, in both directions.
test("a topbar menu and the Saved menu dismiss each other", async ({ page }) => {
  await page.locator(".recon-fav-btn").click();
  await expect(savedMenu(page)).toBeVisible();

  await page.locator("#rm-picker").click();
  await expect(page.locator("#rm-menu-pop")).toBeVisible();
  await expect(savedMenu(page)).toHaveCount(0);

  await page.locator(".recon-fav-btn").click();
  await expect(savedMenu(page)).toBeVisible();
  await expect(page.locator("#rm-menu-pop")).toBeHidden();
});

test("clicking the Saved button again closes its own menu", async ({ page }) => {
  await page.locator(".recon-fav-btn").click();
  await expect(savedMenu(page)).toBeVisible();
  await page.locator(".recon-fav-btn").click();
  await expect(savedMenu(page)).toHaveCount(0);
});

// Picking a favourite closes the menu and runs it — the menu must not survive
// the re-render its own query triggers.
test("picking a favourite closes the Saved menu", async ({ page }) => {
  await page.locator(".recon-fav-btn").click();
  await expect(savedMenu(page)).toBeVisible();

  await page.locator(".recon-fav-name").first().click();
  await expect(savedMenu(page)).toHaveCount(0);
  await expect(page.locator(".recon-issue").first()).toBeVisible();
});
