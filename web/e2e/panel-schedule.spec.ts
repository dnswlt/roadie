// The edit panel's schedule-period dropdowns, for roadmaps that plan in PIs.
// Same shape as the gesture specs — seed via API → act in the browser → assert
// via API → purge — but the act is a <select> pick rather than a pointer path,
// and two assertions read the DOM. Both exceptions are on purpose:
//
// What is being pinned only exists in a real browser. A pick keeps focus in the
// select, which makes the panel skip its rebuild (panel.ts), so every other
// control has to be written by hand — and a select left showing the period the
// date no longer starts on is not a cosmetic lie: picking the entry already
// displayed fires no change event, so that boundary becomes unreachable. Which
// period a dropdown *displays* is client-derived state the server cannot be
// asked about, so it is asserted on the element, as panel-keyboard.spec.ts
// asserts .selected for the same reason. Every date, as everywhere else here,
// is still read back from the API.
//
// The date arithmetic itself (collapse, exact-edge matching) is unit-tested in
// schedule.test.ts and deliberately not re-tested through a browser.

import { expect, test, type Page } from "@playwright/test";
import {
  addMilestone,
  laneItems,
  laneMilestones,
  purgeRoadmap,
  seedRoadmap,
  setSchedule,
  type Seeded,
} from "./support";

// Three adjacent periods, the shape of a PI cadence.
const PERIODS = [
  { label: "PI2026-01", startDate: "2026-01-05", endDate: "2026-02-27" },
  { label: "PI2026-03", startDate: "2026-03-02", endDate: "2026-04-24" },
  { label: "PI2026-05", startDate: "2026-04-27", endDate: "2026-06-19" },
];

let seeded: Seeded;

test.beforeEach(async ({ request }) => {
  // The item starts and ends mid-period, so nothing is on a boundary yet.
  seeded = await seedRoadmap(request, ["Work"], {
    startDate: "2026-01-19",
    endDate: "2026-03-10",
  });
  await setSchedule(request, seeded.roadmapId, PERIODS);
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

const startSelect = (page: Page) => page.locator('#panel select[aria-label="Start period"]');
const endSelect = (page: Page) => page.locator('#panel select[aria-label="End period"]');
const startInput = (page: Page) => page.locator("#panel .panel-date-input").first();

// shown is what a dropdown currently displays — "—" when the date it belongs
// to is not a period edge.
async function shown(select: ReturnType<typeof startSelect>): Promise<string> {
  return (await select.locator("option:checked").innerText()).trim();
}

async function openItem(page: Page): Promise<void> {
  await page.goto(`/?roadmap=${seeded.roadmapId}&item=${seeded.items[0]!.id}`);
  await startSelect(page).waitFor();
}

test("picking periods sets the item's dates", async ({ page, request }) => {
  await openItem(page);
  expect(await shown(startSelect(page))).toBe("—"); // mid-period start
  expect(await shown(endSelect(page))).toBe("—");

  await startSelect(page).selectOption({ label: "PI2026-01" });
  await endSelect(page).selectOption({ label: "PI2026-03" });

  await expect
    .poll(async () => {
      const it = (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!;
      return [it.startDate, it.endDate];
    })
    .toEqual(["2026-01-05", "2026-04-24"]);
});

test("a pick that would invert the range collapses the item onto that period", async ({
  page,
  request,
}) => {
  await openItem(page);
  // The item ends 2026-03-10, before this period starts.
  await startSelect(page).selectOption({ label: "PI2026-05" });

  await expect
    .poll(async () => {
      const it = (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!;
      return [it.startDate, it.endDate];
    })
    .toEqual(["2026-04-27", "2026-06-19"]);
  // The end moved too, so the dropdown that was not touched has to say so.
  expect(await shown(endSelect(page))).toBe("PI2026-05");
});

test("a typed date moves its dropdown, leaving every boundary pickable", async ({
  page,
  request,
}) => {
  await openItem(page);
  await startSelect(page).selectOption({ label: "PI2026-01" });
  expect(await shown(startSelect(page))).toBe("PI2026-01");

  // Type a date inside the same period and commit it by moving focus to the
  // select — focus never leaves the panel, so the panel does not rebuild.
  await startInput(page).fill("2026-01-19");
  await startSelect(page).focus();
  expect(await shown(startSelect(page))).toBe("—");

  // The regression this guards: with the dropdown still reading PI2026-01,
  // picking PI2026-01 is a no-op event and the boundary can't be restored.
  await startSelect(page).selectOption({ label: "PI2026-01" });
  await expect
    .poll(async () => (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!.startDate)
    .toBe("2026-01-05");
});

test("typing a date does not change the roadmap until editing finishes", async ({
  page,
  request,
}) => {
  await openItem(page);
  await startInput(page).fill("2023-01-19");

  // The draft is visible, but neither the stored item nor the timeline moves
  // while the user is still assembling the date.
  expect(await startInput(page).inputValue()).toBe("2023-01-19");
  expect((await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!.startDate).toBe(
    "2026-01-19",
  );

  await startInput(page).press("Enter");
  await expect
    .poll(async () => (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!.startDate)
    .toBe("2023-01-19");
});

test("month and quarter inputs resolve at their field boundary", async ({ page, request }) => {
  await openItem(page);
  const endInput = page.locator("#panel .panel-date-input").nth(1);

  await endInput.fill("Q3/2026");
  await endInput.press("Enter");
  await startInput(page).fill("04/2026");
  await startInput(page).press("Enter");

  await expect
    .poll(async () => {
      const item = (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!;
      return [item.startDate, item.endDate];
    })
    .toEqual(["2026-04-01", "2026-09-30"]);
});

test("the calendar commits its selection immediately", async ({ page, request }) => {
  await openItem(page);
  await page.getByRole("button", { name: "Choose start date" }).click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () => (await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!.startDate)
    .toBe("2026-01-20");
});

test("an invalid typed date stays local and is marked", async ({ page, request }) => {
  await openItem(page);
  await startInput(page).fill("2026-02-30");
  await startSelect(page).focus();

  await expect(startInput(page)).toHaveAttribute("aria-invalid", "true");
  expect((await laneItems(request, seeded.roadmapId, seeded.laneId))[0]!.startDate).toBe(
    "2026-01-19",
  );
});

test("a milestone's Due in lands on the period's last day", async ({ page, request }) => {
  const id = await addMilestone(request, seeded.laneId, "Cutoff", "2026-02-10");
  await page.goto(`/?roadmap=${seeded.roadmapId}&milestone=${id}`);
  const due = page.locator('#panel select[aria-label="Due in period"]');
  await due.waitFor();
  expect(await shown(due)).toBe("—");

  await due.selectOption({ label: "PI2026-03" });

  await expect
    .poll(async () => (await laneMilestones(request, seeded.roadmapId, seeded.laneId))[0]!.date)
    .toBe("2026-04-24");
});
