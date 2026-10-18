import { defineConfig, devices } from "@playwright/test"

/**
 * Browser end-to-end configuration.
 *
 * These tests drive the real SPA against a running BhoomiTrace backend. They are
 * deliberately kept out of the default `pnpm test` glob (which is `*.test.ts`)
 * and out of the app's `tsconfig.json` include, so the standard CI checks stay
 * fast and browser-free. Run them explicitly with `pnpm test:e2e` once the API
 * and database are up.
 *
 * The frontend dev server is started automatically and proxies `/api` to
 * `E2E_API_URL` (default `http://127.0.0.1:3000`), so the browser sees a single
 * origin and session cookies travel as they would in production behind a proxy.
 */

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173"
const backend = process.env.E2E_API_URL ?? "http://127.0.0.1:3000"

const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value
}
env.VITE_BACKEND_URL = backend

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    // Signed-in session, registered once per run by global setup.
    storageState: ".auth/e2e-user.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "node_modules/.bin/vite --host 127.0.0.1 --port 5173 --strictPort",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
    env,
  },
})
