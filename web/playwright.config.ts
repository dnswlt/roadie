// Playwright config for the e2e gesture smoke layer (see web/e2e). One
// browser, no retries: these tests drive deterministic pointer paths against
// seeded data, so a failure is a regression, not weather — retries would only
// hide flake instead of forcing us to fix its source.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:8090" },
  // The tests get their own server on their own port rather than reusing
  // whatever runs on 8080: the dev server there may be `make dev-oidc`, and
  // the gesture tests are written against the open-auth product surface
  // (seeding is plain fetch — AGENTS.md: "auth off must keep working").
  // Needs the dev DB up (`make db-up`); tests create and purge their own
  // throwaway roadmaps there, never touching existing rows. The frontend is
  // built first since -dev serves web/dist from disk. reuseExistingServer
  // only ever matches a previous e2e server on this port.
  //
  // The Jira Data Center mock runs alongside, on its own port for the same
  // reason: the reconciliation view is hidden outright unless the deployment
  // has a tracker connection, so without it that view could not be reached at
  // all. It serves fixtures and ignores the JQL it is sent (dev/jira).
  webServer: [
    {
      command: "cd ../dev/jira && go run . -addr=localhost:4013",
      url: "http://localhost:4013/healthz",
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command:
        "npm run build && cd .. && DATABASE_URL=postgres://roadie:roadie@localhost:5433/roadie JIRA_URL=http://localhost:4013 go run ./cmd/roadie -dev -addr=localhost:8090",
      url: "http://localhost:8090/healthz",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
