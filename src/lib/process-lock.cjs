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
    const lockPath = getLockPath();
    const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 0);
    try {
        fs.mkdirSync(getDataRoot(), { recursive: true });
    } catch (e) {
        return { ok: false, reason: e.message || String(e) };
    }

    // `wx` is essential here. A read-then-write lock lets two service starts both
    // observe "unlocked" and open the same SQLite database concurrently.
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            fs.writeFileSync(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
            return { ok: true };
        } catch (e) {
            if (e?.code !== 'EEXIST') return { ok: false, reason: e.message || String(e) };

            const existing = readLock();
            if (existing?.pid === process.pid) return { ok: true };
            if (existing && pidAlive(existing.pid)) {
                return { ok: false, reason: `Another TGP server is running (pid ${existing.pid}).`, pid: existing.pid };
            }

            if (!existing) {
                // Another process may be between exclusive creation and writing its
                // payload. Only clear an unreadable lock after it is demonstrably old.
                try {
                    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
                    if (ageMs < 30000) {
                        return { ok: false, reason: 'Another TGP server is acquiring the process lock.' };
                    }
                } catch (statError) {
                    if (statError?.code === 'ENOENT') continue;
                    return { ok: false, reason: statError.message || String(statError) };
                }
            }

            try { fs.unlinkSync(lockPath); } catch (unlinkError) {
                if (unlinkError?.code !== 'ENOENT') {
                    return { ok: false, reason: unlinkError.message || String(unlinkError) };
                }
            }
        }
    }
    return { ok: false, reason: 'Another TGP server acquired the process lock.' };
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
