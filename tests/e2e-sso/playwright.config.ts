import { defineConfig, devices } from '@playwright/test';

// THE HOME'S E2E SUITE, against the LIVE deployment with an injected mock SIWE wallet.
// No webServer: these drive www.faithnet.me to reproduce reported breakages, not a local build.
//
// Moved here from ap-demos 2026-10-13. It lived in a repository that could not run it — ap-demos
// declares no root `@playwright/test`, only one inside `apps/demo-resolution` — while this repository
// had the runner and no suite. Its baseURL defaulted to `https://www.impact-agent.me`, the Home of the
// Base Sepolia / Impact estate that was retired the same day, so the default pointed at a deployment
// nothing can rebuild. It is faithnet's Home now, which is what 18 of the specs already named outright.
export default defineConfig({
  testDir: '.',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.SSO_BASE_URL ?? 'https://www.faithnet.me',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 30_000,
    navigationTimeout: 90_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  outputDir: 'artifacts',
});
