'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Reject paths under common world-writable roots and require a non-symlink
 * parent directory (untrusted users should not be able to replace the parent).
 */
function parentLooksTrusted(target) {
    const parent = path.dirname(target);
    let parentStat;
    try {
        parentStat = fs.lstatSync(parent);
    } catch (_) {
        return false;
    }
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return false;

    const lower = parent.toLowerCase();
    const temp = String(process.env.TEMP || process.env.TMP || '').trim().toLowerCase();
    const localAppData = String(process.env.LOCALAPPDATA || '').trim().toLowerCase();
    const publicDir = String(process.env.PUBLIC || 'C:\\Users\\Public').trim().toLowerCase();
    const rejects = [
        temp,
        publicDir,
        'c:\\users\\public',
        'c:\\windows\\temp',
        'c:\\temp',
    ].filter(Boolean);
    if (localAppData) rejects.push(path.join(localAppData, 'temp').toLowerCase());
    for (const root of rejects) {
        if (!root) continue;
        const norm = path.resolve(root).toLowerCase();
        if (lower === norm || lower.startsWith(`${norm}\\`)) return false;
    }
    return true;
}

function assertRegularFile(target) {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error('not a regular file');
    }
    return st;
}

function runIcacls(args) {
    return spawnSync('icacls', args, {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 15_000,
    });
}

function icaclsOk(result) {
    return !!(result && !result.error && result.status === 0);
}

function restoreAclBackup(target, bakPath) {
    if (!bakPath || !fs.existsSync(bakPath)) return;
    // icacls /restore expects the directory that contains the saved relative paths.
    runIcacls([path.dirname(target), '/restore', bakPath]);
}

/**
 * Restrict a sensitive file on Windows to SYSTEM, Administrators, and the
 * current user. Captures the prior DACL before mutation and restores it if
 * reset/grant fails, so a partial ACL is never left behind. No-op on
 * non-Windows. Best-effort; never throws.
 */
function restrictWindowsFileAcl(filePath) {
    if (process.platform !== 'win32') return false;
    if (filePath == null) return false;
    const raw = String(filePath);
    if (!raw.trim()) return false;
    const target = path.resolve(raw);
    try {
        assertRegularFile(target);
        if (!parentLooksTrusted(target)) return false;
    } catch (_) {
        return false;
    }

    const user = String(process.env.USERNAME || process.env.USER || '').trim();
    const grants = ['SYSTEM:(R,W)', 'Administrators:(R,W)'];
    if (user) grants.push(`${user}:(R,W)`);

    const bakPath = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${process.pid}.acl.bak`,
    );

    try {
        assertRegularFile(target);
        if (!parentLooksTrusted(target)) return false;

        const saved = runIcacls([target, '/save', bakPath]);
        if (!icaclsOk(saved) || !fs.existsSync(bakPath)) return false;

        assertRegularFile(target);
        if (!parentLooksTrusted(target)) {
            restoreAclBackup(target, bakPath);
            return false;
        }
        const reset = runIcacls([target, '/reset']);
        if (!icaclsOk(reset)) {
            restoreAclBackup(target, bakPath);
            return false;
        }

        assertRegularFile(target);
        if (!parentLooksTrusted(target)) {
            restoreAclBackup(target, bakPath);
            return false;
        }
        const args = [target, '/inheritance:r'];
        for (const grant of grants) {
            args.push('/grant:r', grant);
        }
        const result = runIcacls(args);
        if (!icaclsOk(result)) {
            restoreAclBackup(target, bakPath);
            return false;
        }
        return true;
    } catch (_) {
        try { restoreAclBackup(target, bakPath); } catch (__) { /* ignore */ }
        return false;
    } finally {
        try { fs.unlinkSync(bakPath); } catch (_) { /* ignore */ }
    }
}

module.exports = {
    restrictWindowsFileAcl,
};
