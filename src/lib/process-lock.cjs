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

            // Stale cleanup itself must be serialized. Without this mutex, two
            // reclaimers can both inspect the stale PID; one can then unlink the
            // other reclaimer's newly-created live lock and both will start.
            try {
                fs.mkdirSync(reclaimPath);
            } catch (reclaimError) {
                if (reclaimError?.code === 'EEXIST') {
                    try {
                        const reclaimAgeMs = Date.now() - fs.statSync(reclaimPath).mtimeMs;
                        if (reclaimAgeMs >= 30000) {
                            fs.rmdirSync(reclaimPath);
                            continue;
                        }
                    } catch (cleanupError) {
                        if (cleanupError?.code === 'ENOENT') continue;
                        return { ok: false, reason: cleanupError.message || String(cleanupError) };
                    }
                    return { ok: false, reason: 'Another TGP server is reclaiming the process lock.' };
                }
                return { ok: false, reason: reclaimError.message || String(reclaimError) };
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
                try { fs.rmdirSync(reclaimPath); } catch (_) { /* best effort */ }
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
