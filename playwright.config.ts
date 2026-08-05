import { defineConfig } from "@playwright/test";

/**
 * Browser tests (§22). Requires Playwright browsers:
 *   pnpm add -Dw @playwright/test && pnpm exec playwright install chromium
 * Assumes the API is running with the web build served (pnpm build:web && pnpm start:api)
 * and the database freshly seeded (pnpm seed).
 */
export default defineConfig({
  testDir: "tests/browser",
  timeout: 60_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4000" },
  workers: 1,
});
