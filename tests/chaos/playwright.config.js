const { defineConfig } = require('@playwright/test');

/**
 * Phase 5: The Autopsy
 * Enable full Playwright tracing (trace: 'retain-on-failure'), including
 * screenshots and DOM snapshots for every failed test.
 */
module.exports = defineConfig({
  testDir: './',
  timeout: 60000,
  expect: { timeout: 10000 },
  use: {
    baseURL: process.env.TGP_BASE_URL || process.env.BASE_URL || 'http://127.0.0.1:3101',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
