// One popover at a time, across surfaces (popover.ts).
//
// This spec departs from the usual seed/act/assert-via-API shape, deliberately
// and with the same justification panel-keyboard.spec.ts uses for `.selected`:
// whether a dropdown is on screen is client-only state, so the server has
// nothing to be asked about it. The registry's own state machine — supersession,
// idempotent close, the stale-handle guard — is pinned DOM-free in
// popover.test.ts and is not retested here. What only a real browser can answer
// is the wiring: that a real click reaches a capture-phase document listener
// before the opener's own handler, and therefore that opening any one of these
// surfaces dismisses whichever other was open. That is what this covers, one
// pair per surface kind rather than every combination.
//
// The regression that motivated it: every opener used to swallow its own click
// with stopPropagation, which blinded every *other* surface's click-away
// handler — so a panel picker left topbar menus stranded open, and vice versa.

import { expect, test, type Page } from "@playwright/test";
import { purgeRoadmap, seedRoadmap, type Seeded } from "./support";

let seeded: Seeded;

test.beforeEach(async ({ request, page }) => {
  seeded = await seedRoadmap(request, ["Alpha"]);
  await page.addInitScript(() => localStorage.setItem("roadie.view", "timeline"));
  await page.goto(`/?roadmap=${seeded.roadmapId}`);
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

// The roadmap actions menu and the context (eye) menu: two persistent topbar
// dropdowns toggled `hidden`.
const roadmapMenu = (page: Page) => page.locator("#rm-menu-pop");
const contextMenu = (page: Page) => page.locator("#lane-vis-pop");
// A transient node created inside the edit panel.
const depPicker = (page: Page) => page.locator(".dep-pop");
// A transient node appended to the body from the chart.
const laneMenu = (page: Page) => page.locator(".lane-menu");

// selectItem opens the edit panel, which is where the dependency picker lives.
async function selectItem(page: Page): Promise<void> {
  await page.locator(`.bar[data-item-id="${seeded.items[0]!.id}"]`).click();
  await expect(page.locator(".deps-section")).toBeVisible();
}

test("opening one topbar menu dismisses another", async ({ page }) => {
  await page.locator("#rm-actions").click();
  await expect(roadmapMenu(page)).toBeVisible();

  await page.locator("#lane-vis-menu").click();
  await expect(contextMenu(page)).toBeVisible();
  await expect(roadmapMenu(page)).toBeHidden();
});

test("a topbar menu closes on a click outside it", async ({ page }) => {
  await page.locator("#rm-actions").click();
  await expect(roadmapMenu(page)).toBeVisible();

  await page.locator("#chart").click({ position: { x: 5, y: 5 } });
  await expect(roadmapMenu(page)).toBeHidden();
});

// The pair from the original report: a picker in the edit panel and a dropdown
// elsewhere. Before the registry these two knew nothing about each other, and
// the panel picker's swallowed opener click meant the topbar menu never heard
// about it either.
test("opening the dependency picker dismisses a topbar menu", async ({ page }) => {
  await selectItem(page);
  await page.locator("#rm-actions").click();
  await expect(roadmapMenu(page)).toBeVisible();

  await page.locator(".dep-add").first().click();
  await expect(depPicker(page)).toBeVisible();
  await expect(roadmapMenu(page)).toBeHidden();
});

// And the other direction, which also proves the picker survives its own
// opening click — the thing the capture phase buys.
test("opening a topbar menu dismisses the dependency picker", async ({ page }) => {
  await selectItem(page);
  await page.locator(".dep-add").first().click();
  await expect(depPicker(page)).toBeVisible();

  await page.locator("#rm-actions").click();
  await expect(roadmapMenu(page)).toBeVisible();
  await expect(depPicker(page)).toHaveCount(0);
});

// A body-level transient node opened from the chart, against the topbar.
test("the lane menu and a topbar menu dismiss each other", async ({ page }) => {
  await page.locator(".lane-menu-btn").first().click();
  await expect(laneMenu(page)).toBeVisible();

  await page.locator("#rm-actions").click();
  await expect(roadmapMenu(page)).toBeVisible();
  await expect(laneMenu(page)).toHaveCount(0);

  await page.locator(".lane-menu-btn").first().click();
  await expect(laneMenu(page)).toBeVisible();
  await expect(roadmapMenu(page)).toBeHidden();
});

// The opener is exempt from dismissal so that its own handler decides what a
// second click means. Every one of these surfaces treats it as "close".
test("clicking an opener a second time closes its own popover", async ({ page }) => {
  await page.locator("#rm-actions").click();
  await expect(roadmapMenu(page)).toBeVisible();
  await page.locator("#rm-actions").click();
  await expect(roadmapMenu(page)).toBeHidden();

  await page.locator(".lane-menu-btn").first().click();
  await expect(laneMenu(page)).toBeVisible();
  await page.locator(".lane-menu-btn").first().click();
  await expect(laneMenu(page)).toHaveCount(0);
});

// Find is opened by "/" as well as by its button: a keyboard-opened popover
// registers exactly like a clicked one, and is dismissed by the next opener.
test("the find popup joins the same exclusivity", async ({ page }) => {
  // Unlike a click, a keypress does not wait for the app to be ready, and
  // openFind is a no-op until a roadmap is loaded. Wait for the chart.
  await expect(page.locator(`.bar[data-item-id="${seeded.items[0]!.id}"]`)).toBeVisible();
  await page.keyboard.press("/");
  await expect(page.locator("#find-pop")).toBeVisible();

  await page.locator("#rm-actions").click();
  await expect(roadmapMenu(page)).toBeVisible();
  await expect(page.locator("#find-pop")).toBeHidden();
});
