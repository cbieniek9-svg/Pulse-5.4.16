'use strict';

const fs = require('fs');
const path = require('path');
const { getDataRoot } = require('../paths.cjs');

/**
 * Simple PID lock so only one headless Node server owns the data dir.
 * Electron still uses requestSingleInstanceLock separately.
 */
function getLockPath() {
    return path.join(getDataRoot(), 'tgp-server.lock');
}

function readLock() {
    try {
        const raw = fs.readFileSync(getLockPath(), 'utf8');
        const j = JSON.parse(raw);
        return j && Number.isFinite(Number(j.pid)) ? { pid: Number(j.pid), started_at: j.started_at || null } : null;
    } catch (_) {
        return null;
    }
}

function pidAlive(pid) {
    if (!pid || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string, pid?: number }}
 */
function acquireProcessLock() {
    const existing = readLock();
    if (existing && pidAlive(existing.pid) && existing.pid !== process.pid) {
        return { ok: false, reason: `Another TGP server is running (pid ${existing.pid}).`, pid: existing.pid };
    }
    const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 0);
    try {
        fs.mkdirSync(getDataRoot(), { recursive: true });
        fs.writeFileSync(getLockPath(), payload, 'utf8');
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e.message || String(e) };
    }
}

function releaseProcessLock() {
    try {
        const existing = readLock();
        if (existing && existing.pid === process.pid) {
            fs.unlinkSync(getLockPath());
        }
    } catch (_) { /* ignore */ }
}

module.exports = {
    getLockPath,
    acquireProcessLock,
    releaseProcessLock,
    readLock,
    pidAlive,
};
