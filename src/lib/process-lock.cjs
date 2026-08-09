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

function readReclaim(reclaimPath) {
    try {
        const raw = fs.readFileSync(reclaimPath, 'utf8');
        const j = JSON.parse(raw);
        return j && Number.isFinite(Number(j.pid)) ? { pid: Number(j.pid), started_at: j.started_at || null } : null;
    } catch (_) {
        return null;
    }
}

function releaseReclaim(reclaimPath) {
    try {
        const existing = readReclaim(reclaimPath);
        if (existing && existing.pid === process.pid) {
            fs.unlinkSync(reclaimPath);
        }
    } catch (_) { /* ignore */ }
}

/**
 * Acquire the reclaim mutex with verifiable PID ownership.
 * A live paused reclaimer must never be evicted by age alone.
 * @returns {{ ok: true } | { ok: false, reason: string, retry?: boolean }}
 */
function acquireReclaim(reclaimPath) {
    const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 0);

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            fs.writeFileSync(reclaimPath, payload, { encoding: 'utf8', flag: 'wx' });
            return { ok: true };
        } catch (e) {
            if (e?.code === 'EISDIR') {
                // Legacy mkdir-based reclaim mutex from older builds.
                try {
                    const ageMs = Date.now() - fs.statSync(reclaimPath).mtimeMs;
                    if (ageMs < 30000) {
                        return { ok: false, reason: 'Another TGP server is reclaiming the process lock.' };
                    }
                    fs.rmSync(reclaimPath, { recursive: true, force: true });
                    continue;
                } catch (legacyError) {
                    if (legacyError?.code === 'ENOENT') return { ok: false, retry: true };
                    return { ok: false, reason: legacyError.message || String(legacyError) };
                }
            }
            if (e?.code !== 'EEXIST') return { ok: false, reason: e.message || String(e) };

            const existing = readReclaim(reclaimPath);
            if (existing?.pid === process.pid) return { ok: true };
            if (existing && pidAlive(existing.pid)) {
                return { ok: false, reason: 'Another TGP server is reclaiming the process lock.' };
            }

            if (!existing) {
                // Unreadable / malformed reclaim with no owner PID: only clear when old.
                try {
                    const ageMs = Date.now() - fs.statSync(reclaimPath).mtimeMs;
                    if (ageMs < 30000) {
                        return { ok: false, reason: 'Another TGP server is reclaiming the process lock.' };
                    }
                } catch (statError) {
                    if (statError?.code === 'ENOENT') return { ok: false, retry: true };
                    return { ok: false, reason: statError.message || String(statError) };
                }
            }

            // Owner is dead (or abandoned malformed reclaim is old) — clear and retry once.
            try {
                fs.unlinkSync(reclaimPath);
            } catch (unlinkError) {
                if (unlinkError?.code === 'ENOENT') return { ok: false, retry: true };
                if (unlinkError?.code === 'EISDIR' || unlinkError?.code === 'EPERM') {
                    try {
                        fs.rmSync(reclaimPath, { recursive: true, force: true });
                    } catch (rmError) {
                        if (rmError?.code === 'ENOENT') return { ok: false, retry: true };
                        return { ok: false, reason: rmError.message || String(rmError) };
                    }
                } else {
                    return { ok: false, reason: unlinkError.message || String(unlinkError) };
                }
            }
        }
    }
    return { ok: false, reason: 'Another TGP server is reclaiming the process lock.' };
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string, pid?: number }}
 */
function acquireProcessLock() {
    const lockPath = getLockPath();
    const reclaimPath = `${lockPath}.reclaim`;
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

            let existing = readLock();
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

            // Stale cleanup itself must be serialized with a PID-owned reclaim mutex.
            // Age alone must never evict a live paused reclaimer.
            const reclaim = acquireReclaim(reclaimPath);
            if (!reclaim.ok) {
                if (reclaim.retry) continue;
                return { ok: false, reason: reclaim.reason };
            }
            try {
                existing = readLock();
                if (existing?.pid === process.pid) return { ok: true };
                if (existing && pidAlive(existing.pid)) {
                    return { ok: false, reason: `Another TGP server is running (pid ${existing.pid}).`, pid: existing.pid };
                }
                try { fs.unlinkSync(lockPath); } catch (unlinkError) {
                    if (unlinkError?.code !== 'ENOENT') {
                        return { ok: false, reason: unlinkError.message || String(unlinkError) };
                    }
                }
                try {
                    fs.writeFileSync(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
                    return { ok: true };
                } catch (createError) {
                    if (createError?.code === 'EEXIST') {
                        return { ok: false, reason: 'Another TGP server acquired the process lock.' };
                    }
                    return { ok: false, reason: createError.message || String(createError) };
                }
            } finally {
                releaseReclaim(reclaimPath);
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
