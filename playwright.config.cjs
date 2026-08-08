/** @type {import('@playwright/test').PlaywrightTestConfig} */
const { defineConfig } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

/**
 * E2E runs against a throwaway server on its own port and its own data directory.
 *
 * The suite includes destructive specs (security_audit, ui-gremlin). Pointing them at
 * the default 3001 meant that running `npm test` on the store PC — where the
 * TGP-CommandCenter service is already listening — would have Playwright reuse the
 * live server and drive those specs against real store data.
 */
const E2E_PORT = process.env.TGP_E2E_PORT || '3101';
const E2E_HTTPS_PORT = process.env.TGP_E2E_HTTPS_PORT || String(Number(E2E_PORT) + 442);
const E2E_DATA_DIR = process.env.TGP_E2E_DATA_DIR || path.join(__dirname, 'tests', '.e2e-data');

// The DB is opened, not created, so the directory has to exist before either the
// seed step or the server starts.
fs.mkdirSync(path.join(E2E_DATA_DIR, 'data'), { recursive: true });

// globalSetup seeds through src/db.cjs in this process's env, so it has to resolve
// to the same directory the test server will open.
process.env.TGP_DATA_DIR = E2E_DATA_DIR;

module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests'),
  // Without this Playwright also collects the ~120 node:test `*.test.cjs` files,
  // which belong to `npm run test:unit`.
  testMatch: '**/*.spec.js',
  globalSetup: require.resolve('./tests/playwright-global-setup.cjs'),
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
  },
  reporter: [['list']],
  webServer: {
    command: 'node scripts/start-api-for-tests.cjs',
    url: `http://127.0.0.1:${E2E_PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      TGP_PORT: E2E_PORT,
      TGP_HTTPS_PORT: E2E_HTTPS_PORT,
      TGP_DATA_DIR: E2E_DATA_DIR,
      // DevicesTab pairing URLs require an active HTTPS public base URL.
      TGP_HTTPS: '1',
      TGP_ALLOW_LAN_CLIENTS: '1',
      // Keep desktop/HTTP on loopback; HTTPS still starts for pairing + credential checks.
      TGP_BIND_HOST: '127.0.0.1',
    },
  },
});
