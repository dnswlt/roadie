// Browser-side helpers shared by more than one spec. Kept apart from
// support.ts, which is strictly the JSON API: everything here drives the app
// through the same surface a user does.

import { expect, type Page } from "@playwright/test";

// pickFilter opens the filter menu, picks one row, and closes the menu again.
// The closing matters and is easy to forget: picking rebuilds the menu in
// place rather than dismissing it, so an open popover would sit over the chart
// and swallow the pointerdown of whatever gesture the test performs next —
// a blocked-gesture test would then pass for the wrong reason.
export async function pickFilter(page: Page, name: RegExp | string): Promise<void> {
  await page.locator("#filter-menu").click();
  await page.getByRole("button", { name }).click();
  await page.locator("#filter-menu").click();
  await expect(page.locator("#filter-pop")).toBeHidden();
}
