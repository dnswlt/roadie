// Jumping to an entity from Find, across all three ways it can be off-screen.
//
// revealAndSelect's contract is that anything hiding the target is undone
// first: a hidden context, a folded parent, an active filter (AGENTS.md). The
// undoing is unit-tested in src/state.test.ts; what is not, and cannot be, is
// that the target is then really on the chart — every hider is client-only
// state, so the server has no answer, exactly as in filter.spec.ts. Dropping
// the unfold from revealAndSelect leaves the whole suite green otherwise.
//
// Find is driven the way a user drives it: "/" opens it, the query is typed,
// Enter commits the cursor row.

import { expect, test, type Page } from "@playwright/test";
import { addItem, addLane, markFlagged, purgeRoadmap, seedRoadmap, type Seeded } from "./support";
import { pickFilter } from "./ui";

let seeded: Seeded;

test.beforeEach(async ({ request }) => {
  seeded = await seedRoadmap(request, ["Alpha", "Beta"]);
});

test.afterEach(async ({ request }) => {
  await purgeRoadmap(request, seeded.roadmapId);
});

function bar(page: Page, itemId: number) {
  return page.locator(`.bar[data-item-id="${itemId}"], .child-bar[data-item-id="${itemId}"]`);
}

// findAndCommit types a query into the find popup and commits the top row.
async function findAndCommit(page: Page, query: string): Promise<void> {
  await page.keyboard.press("/");
  const input = page.locator(".find-input");
  await expect(input).toBeVisible();
  await input.fill(query);
  await expect(page.locator(".find-row").first()).toBeVisible();
  await input.press("Enter");
}

// Folded parents and hidden contexts are both persisted per roadmap, so the
// starting state is planted rather than clicked: the fold is this test's
// arrangement, and the jump is its act (as with the view preference).
async function open(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript(
    (data) => {
      localStorage.setItem("roadie.view", "timeline");
      for (const [k, v] of Object.entries(data)) localStorage.setItem(k, JSON.stringify(v));
    },
    prefs,
  );
  await page.goto(`/?roadmap=${seeded.roadmapId}`);
  await expect(bar(page, seeded.items[0]!.id)).toBeVisible();
}

test("jumping to a child of a folded parent unfolds it", async ({ page, request }) => {
  const parentId = seeded.items[0]!.id;
  const childId = await addItem(request, seeded.laneId, "Buried Child", parentId);
  await open(page, { [`roadie.collapsed.${seeded.roadmapId}`]: [parentId] });
  await expect(bar(page, childId)).toHaveCount(0); // folded away

  await findAndCommit(page, "Buried Child");
  await expect(bar(page, childId)).toBeVisible();
});

test("jumping to an item in a hidden context unhides it", async ({ page, request }) => {
  const laneId = await addLane(request, seeded.roadmapId, "Hidden");
  const needle = await addItem(request, laneId, "Needle");
  await open(page, { [`roadie.hidden.${seeded.roadmapId}`]: [laneId] });
  await expect(bar(page, needle)).toHaveCount(0); // its whole context is hidden

  await findAndCommit(page, "Needle");
  await expect(bar(page, needle)).toBeVisible();
});

test("jumping to an item outside the filter clears the filter", async ({ page, request }) => {
  await markFlagged(request, seeded.items[0]!.id); // Alpha
  // Gamma is the control: it matches nothing and the jump never touches it, so
  // only a genuinely cleared filter brings it back. Asserting on the jump
  // target alone would also pass for a chart that merely exempts the selected
  // item — the coherent-chart-not-an-exception design this deliberately is not
  // (AGENTS.md), and a difference invisible from the target's own row.
  const bystander = await addItem(request, seeded.laneId, "Gamma");
  await open(page);
  await pickFilter(page, /^Flagged \(/);
  await expect(bar(page, seeded.items[1]!.id)).toHaveCount(0); // Beta filtered out
  await expect(bar(page, bystander)).toHaveCount(0);

  await findAndCommit(page, "Beta");
  await expect(bar(page, seeded.items[1]!.id)).toBeVisible(); // the jump target
  await expect(bar(page, bystander)).toBeVisible(); // and everything else with it
});
