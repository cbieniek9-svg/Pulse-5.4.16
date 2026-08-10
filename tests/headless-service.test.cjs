'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function withTempDataDir(prefix, fn) {
    const previous = process.env.TGP_DATA_DIR;
    const hadPrevious = Object.prototype.hasOwnProperty.call(process.env, 'TGP_DATA_DIR');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    process.env.TGP_DATA_DIR = dir;
    try {
        return fn(dir);
    } finally {
        if (hadPrevious) process.env.TGP_DATA_DIR = previous;
        else delete process.env.TGP_DATA_DIR;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
}

async function withTempDataDirAsync(prefix, fn) {
    const previous = process.env.TGP_DATA_DIR;
    const hadPrevious = Object.prototype.hasOwnProperty.call(process.env, 'TGP_DATA_DIR');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    process.env.TGP_DATA_DIR = dir;
    try {
        return await fn(dir);
    } finally {
        if (hadPrevious) process.env.TGP_DATA_DIR = previous;
        else delete process.env.TGP_DATA_DIR;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
}

function waitForPath(target, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(target)) return true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    return false;
}

test('process lock acquires and releases under TGP_DATA_DIR', () => {
    withTempDataDir('tgp-lock-', () => {
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
});

test('process lock reclaims a stale PID but fails closed on a new malformed lock', () => {
    withTempDataDir('tgp-lock-stale-', () => {
        const { acquireProcessLock, releaseProcessLock, getLockPath, readLock } = require('../src/lib/process-lock.cjs');

        fs.writeFileSync(getLockPath(), JSON.stringify({ pid: 2147483647 }), 'utf8');
        assert.equal(acquireProcessLock().ok, true);
        assert.equal(readLock()?.pid, process.pid);
        releaseProcessLock();

        fs.writeFileSync(getLockPath(), '', 'utf8');
        const blocked = acquireProcessLock();
        assert.equal(blocked.ok, false);
        assert.match(blocked.reason, /acquiring the process lock/);
    });
});

test('process lock fails closed while stale-lock reclamation is already in progress', () => {
    withTempDataDir('tgp-lock-reclaim-', () => {
        const { acquireProcessLock, getLockPath } = require('../src/lib/process-lock.cjs');
        fs.writeFileSync(getLockPath(), JSON.stringify({ pid: 2147483647 }), 'utf8');
        // Simulate a live foreign reclaimer (PID that is alive in this process tree).
        // Use a child so ownership is verifiably alive and distinct from this test.
        const reclaimPath = `${getLockPath()}.reclaim`;
        const child = spawn(process.execPath, ['-e', `
            const fs = require('fs');
            fs.writeFileSync(${JSON.stringify(reclaimPath)}, JSON.stringify({ pid: process.pid }));
            setInterval(() => {}, 1000);
        `], { stdio: 'ignore' });

        try {
            assert.equal(waitForPath(reclaimPath), true);
            const blocked = acquireProcessLock();
            assert.equal(blocked.ok, false);
            assert.match(blocked.reason, /reclaiming the process lock/);
        } finally {
            child.kill('SIGTERM');
        }
    });
});

test('process lock does not steal reclaim mutex from a live paused reclaimer after age timeout', async () => {
    await withTempDataDirAsync('tgp-lock-reclaim-age-', async () => {
        const { acquireProcessLock, releaseProcessLock, getLockPath, readLock } = require('../src/lib/process-lock.cjs');
        fs.writeFileSync(getLockPath(), JSON.stringify({ pid: 2147483647 }), 'utf8');
        const reclaimPath = `${getLockPath()}.reclaim`;
        const child = spawn(process.execPath, ['-e', `
            const fs = require('fs');
            fs.writeFileSync(${JSON.stringify(reclaimPath)}, JSON.stringify({ pid: process.pid }));
            setInterval(() => {}, 1000);
        `], { stdio: 'ignore' });

        try {
            assert.equal(waitForPath(reclaimPath), true);
            const old = new Date(Date.now() - 60000);
            fs.utimesSync(reclaimPath, old, old);

            const blocked = acquireProcessLock();
            assert.equal(blocked.ok, false, 'live reclaim owner must not be evicted by age alone');
            assert.match(blocked.reason, /reclaiming the process lock/);
            assert.equal(readLock()?.pid, 2147483647);
        } finally {
            await new Promise((resolve) => {
                const done = () => resolve();
                child.once('exit', done);
                try { child.kill('SIGTERM'); } catch (_) { done(); }
                setTimeout(done, 5000);
            });
        }

        assert.equal(acquireProcessLock().ok, true);
        assert.equal(readLock()?.pid, process.pid);
        releaseProcessLock();
    });
});

test('probeLocalApiReady returns false when nothing listens', async () => {
    const { probeLocalApiReady } = require('../src/lib/app-boot.cjs');
    const probe = await probeLocalApiReady(59999, '127.0.0.1', 300);
    assert.equal(probe.ok, false);
    assert.equal(probe.restart_required, false);
});
