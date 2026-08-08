'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: '.',
    testMatch: 'ui-gremlin.spec.js',
    timeout: 90_000,
    fullyParallel: false,
    workers: 1,
    reporter: [['list']],
    use: {
        baseURL: process.env.TGP_BASE_URL || 'http://127.0.0.1:3001',
        trace: 'off',
        screenshot: 'off',
        video: 'off',
    },
});
