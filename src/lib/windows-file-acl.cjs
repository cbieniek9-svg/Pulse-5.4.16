'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

/**
 * Restrict a sensitive file on Windows to SYSTEM, Administrators, and the
 * current user. No-op on non-Windows. Best-effort; never throws.
 */
function restrictWindowsFileAcl(filePath) {
    if (process.platform !== 'win32') return false;
    const target = path.resolve(String(filePath || ''));
    if (!target) return false;
    const user = String(process.env.USERNAME || process.env.USER || '').trim();
    const grants = ['SYSTEM:(R,W)', 'Administrators:(R,W)'];
    if (user) grants.push(`${user}:(R,W)`);
    try {
        const args = [target, '/inheritance:r'];
        for (const grant of grants) {
            args.push('/grant:r', grant);
        }
        const result = spawnSync('icacls', args, {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 15_000,
        });
        return !result.error && result.status === 0;
    } catch (_) {
        return false;
    }
}

module.exports = {
    restrictWindowsFileAcl,
};
