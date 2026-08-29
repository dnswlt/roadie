// An integration milestone's date is a published contract. Both date-entry
// paths must warn before moving it, using current consumer usage rather than
// the count loaded when the panel opened.

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  addMilestone,
  laneMilestones,
  purgeRoadmap,
  seedRoadmap,
  setSchedule,
  type Seeded,
} from "./support";

let provider: Seeded;
let consumers: Seeded[];
let milestoneId: number;

async function publishAndReadUID(request: APIRequestContext): Promise<string> {
  const publish = await request.patch(`/api/milestones/${milestoneId}`, {
    data: { integration: true },
  });
  expect(publish.ok(), `publish milestone -> ${publish.status()}`).toBe(true);
  const roadmap = await request.get(`/api/roadmaps/${provider.roadmapId}`);
  expect(roadmap.ok(), `GET provider roadmap -> ${roadmap.status()}`).toBe(true);
  const full = (await roadmap.json()) as {
    lanes: { milestones: { id: number; uid: string }[] }[];
  };
  return full.lanes.flatMap((lane) => lane.milestones).find((ms) => ms.id === milestoneId)!.uid;
}

async function addConsumer(request: APIRequestContext, sourceUid: string): Promise<Seeded> {
  const consumer = await seedRoadmap(request, []);
  const mirror = await request.post(`/api/lanes/${consumer.laneId}/milestones`, {
    data: { sourceUid },
  });
  expect(mirror.ok(), `create milestone mirror -> ${mirror.status()}`).toBe(true);
  return consumer;
}

test.beforeEach(async ({ request }) => {
  provider = await seedRoadmap(request, []);
  consumers = [];
  milestoneId = await addMilestone(request, provider.laneId, "Provided#2", "2026-02-10");
  const sourceUid = await publishAndReadUID(request);
  consumers.push(await addConsumer(request, sourceUid));
  consumers.push(await addConsumer(request, sourceUid));
});

test.afterEach(async ({ request }) => {
  for (const consumer of consumers) await purgeRoadmap(request, consumer.roadmapId);
  await purgeRoadmap(request, provider.roadmapId);
});

async function openMilestone(page: Page): Promise<void> {
  await page.goto(`/?roadmap=${provider.roadmapId}&milestone=${milestoneId}`);
  await page.locator('#panel input[aria-label="Date"]').waitFor();
}

async function expectWarning(page: Page, next: string): Promise<void> {
  await expect(page.locator("#dialog h3")).toHaveText(
    "2 other roadmaps depend on this milestone",
  );
  await expect(page.locator("#dialog p")).toHaveText(
    `Change the date of "Provided#2" from 2026-02-10 to ${next}? Their linked milestones will move to the new date.`,
  );
}

test("typed date changes can be cancelled before moving consumers", async ({ page, request }) => {
  await openMilestone(page);
  const date = page.locator('#panel input[aria-label="Date"]');
  await date.fill("2026-03-15");
  await date.press("Enter");
  await expectWarning(page, "2026-03-15");

  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect(date).toHaveValue("2026-02-10");
  expect((await laneMilestones(request, provider.roadmapId, provider.laneId))[0]!.date).toBe(
    "2026-02-10",
  );
});

test("a period pick warns before moving the integration milestone", async ({ page, request }) => {
  await setSchedule(request, provider.roadmapId, [
    { label: "PI 2", startDate: "2026-03-01", endDate: "2026-04-24" },
  ]);
  await openMilestone(page);

  await page.locator('#panel select[aria-label="Due in period"]').selectOption({ label: "PI 2" });
  await expectWarning(page, "2026-04-24");
  await page.getByRole("button", { name: "Change date", exact: true }).click();

  await expect
    .poll(
      async () =>
        (await laneMilestones(request, provider.roadmapId, provider.laneId))[0]!.date,
    )
    .toBe("2026-04-24");
});
