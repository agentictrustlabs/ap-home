import { defineConfig, devices } from '@playwright/test';

// The estate site's own pages, against the LIVE site. Read-only: no sign-in, no writes, no model calls.
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: true,
  workers: 4,
  reporter: 'list',
  use: { baseURL: process.env.ESTATE_URL ?? 'https://faithnet.estate', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // Needs `sudo npx playwright install-deps webkit` on this machine.
    { name: 'webkit', use: { ...devices['iPhone 14'] } },
  ],
  outputDir: 'artifacts',
});
