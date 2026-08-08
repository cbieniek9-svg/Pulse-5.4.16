'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('process lock acquires and releases under TGP_DATA_DIR', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-lock-'));
    process.env.TGP_DATA_DIR = dir;
    // Re-require after env set (module reads getDataRoot at call time — OK)
    const {
        acquireProcessLock,
        releaseProcessLock,
        getLockPath,
        readLock,
    } = require('../src/lib/process-lock.cjs');

    const first = acquireProcessLock();
    assert.equal(first.ok, true);
    assert.equal(readLock()?.pid, process.pid);
    assert.equal(fs.existsSync(getLockPath()), true);

    releaseProcessLock();
    assert.equal(readLock(), null);
});

test('probeLocalApiReady returns false when nothing listens', async () => {
    const { probeLocalApiReady } = require('../src/lib/app-boot.cjs');
    const probe = await probeLocalApiReady(59999, '127.0.0.1', 300);
    assert.equal(probe.ok, false);
    assert.equal(probe.restart_required, false);
});
