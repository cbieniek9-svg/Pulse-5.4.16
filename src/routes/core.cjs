'use strict';

const bcrypt = require('bcryptjs');
const { isTrainingStaff } = require('../lib/training-staff.cjs');
const { isManagerRole } = require('../lib/staff-permissions.cjs');
const { logManagerAudit } = require('../lib/audit-log.cjs');

const DUMMY_BCRYPT_HASH = '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.';

/**
 * @param {import('express').Application} server
 * @param {object} ctx
 * @param {function} ctx.wrap
 * @param {function} ctx.fail
 * @param {function} ctx.requireSession
 * @param {object} ctx.db
 * @param {object} ctx.auth
 */
function registerCoreRoutes(server, ctx) {
    const { wrap, fail, requireSession, db, auth } = ctx;
    const fs = require('fs');
    const { getDbPath } = require('../paths.cjs');

    server.get('/api/health', wrap(async (req, res) => {
        if (!requireSession(req, res)) return;

        const dbPath = getDbPath();
        let dbSize = null;
        try { dbSize = fs.statSync(dbPath).size; } catch (_) { /* briefly locked */ }
        const bootHealth = typeof ctx.getBootHealth === 'function' ? ctx.getBootHealth() : null;
        const network = typeof ctx.getNetworkInfo === 'function' ? ctx.getNetworkInfo() : null;
        res.json({
            ok: true,
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            dbSize,
            boot_health: bootHealth ? {
                ok: bootHealth.ok,
                status: bootHealth.status,
                checked_at: bootHealth.checked_at,
                errors: bootHealth.errors || [],
                warnings: bootHealth.warnings || [],
            } : null,
            network: network ? {
                allow_lan_clients: network.allow_lan_clients,
                http_bind_host: network.http_bind_host || '127.0.0.1',
                https_bind_host: network.https_bind_host || network.bind_host,
                bind_host: network.bind_host,
                port: network.port,
                https_enabled: !!network.https_enabled,
                https_active: !!network.https_active,
                https_port: network.https_port || null,
                lan_ready: !!network.lan_ready,
                public_base_url: network.public_base_url,
                public_https_base_url: network.https_active
                    ? (network.public_https_base_url || '')
                    : '',
                lan_addresses: network.lan_addresses || [],
                warnings: network.warnings || [],
                lan_warning: (network.warnings || []).join(' '),
            } : null,
        });
    }));

    server.post('/api/mobile-auth', wrap(async (req, res) => {
        const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ');
        const pin = String(req.body?.pin ?? '').trim();
        if (!name || !pin) return fail(res, 400, 'Name and PIN are required.');

        const lock = auth.getRateLimitStatus(name);
        if (!lock.allowed) {
            const mins = Math.ceil((lock.lockedUntil - Date.now()) / 60000);
            return fail(res, 429, `Too many failed attempts. Try again in ${mins} minute(s).`);
        }
        if (isTrainingStaff(name)) {
            await bcrypt.compare(pin, DUMMY_BCRYPT_HASH);
            auth.recordLoginAttempt(name, false);
            return fail(res, 403, 'Account access is revoked.', 'ACCOUNT_ACCESS_REVOKED');
        }

        // Exact match first, then case-insensitive (typed manager unlock often varies casing).
        const user = db.get('SELECT * FROM staff WHERE name=?', name)
            || db.get('SELECT * FROM staff WHERE LOWER(TRIM(name)) = LOWER(?)', name);
        if (!user) {
            await bcrypt.compare(pin, DUMMY_BCRYPT_HASH);
            auth.recordLoginAttempt(name, false);
            return fail(res, 403, 'Invalid credentials.', 'INVALID_CREDENTIALS');
        }

        const match = user.pin_hashed ? await bcrypt.compare(pin, user.pin) : user.pin === pin;
        if (!match) {
            auth.recordLoginAttempt(name, false);
            return fail(res, 403, 'Invalid credentials.', 'INVALID_CREDENTIALS');
        }

        // Account status only after successful PIN verification (avoid pre-PIN enumeration).
        let currentUser = db.get('SELECT * FROM staff WHERE id=?', user.id);
        if (currentUser && (
            Number(currentUser.active) !== 1
            || Number(currentUser.app_access) !== 1
        )) {
            auth.recordLoginAttempt(name, false);
            return fail(res, 403, 'Account access is revoked.', 'ACCOUNT_ACCESS_REVOKED');
        }
        if (!currentUser) {
            auth.recordLoginAttempt(name, false);
            return fail(res, 403, 'Invalid credentials.', 'INVALID_CREDENTIALS');
        }

        auth.recordLoginAttempt(name, true);
        if (!currentUser.pin_hashed) {
            const hashed = await bcrypt.hash(pin, 10);
            const eligible = db.get('SELECT * FROM staff WHERE id=?', currentUser.id);
            if (!eligible || Number(eligible.active) !== 1 || Number(eligible.app_access) !== 1) {
                auth.recordLoginAttempt(name, false);
                if (eligible) return fail(res, 403, 'Account access is revoked.', 'ACCOUNT_ACCESS_REVOKED');
                return fail(res, 403, 'Invalid credentials.', 'INVALID_CREDENTIALS');
            }
            db.transaction(() => db.run('UPDATE staff SET pin=?, pin_hashed=1 WHERE id=?', hashed, eligible.id))();
            currentUser = eligible;
        }
        const sessionToken = auth.createSession(currentUser);
        if (isManagerRole(currentUser.role)) {
            logManagerAudit(db, {
                req,
                session: auth.getSession(sessionToken),
                action: 'manager_login',
                targetType: 'session',
                summary: `${currentUser.name} logged in as ${currentUser.role}`,
                metadata: { role: currentUser.role, training: isTrainingStaff(currentUser.name) },
            });
        }

        res.json({
            success: true,
            token: sessionToken,
            user: {
                name: currentUser.name,
                role: currentUser.role,
                permissions: currentUser.permissions,
                training: isTrainingStaff(currentUser.name),
            },
        });
    }));

    /**
     * Revoke a session server-side. Signing out used to only clear the client's
     * storage, leaving the token usable until it idled out 12 hours later.
     */
    server.post('/api/logout', wrap(async (req, res) => {
        const token = req.headers?.['x-session-token'] ?? req.body?.token ?? req.body?.userContext?.token;
        const session = auth.getSession(token);
        if (session && isManagerRole(session.role)) {
            logManagerAudit(db, {
                req,
                session,
                action: 'manager_logout',
                targetType: 'session',
                summary: `${session.name} signed out`,
                metadata: { role: session.role },
            });
        }
        auth.destroySession(token);
        res.json({ success: true });
    }));
}

module.exports = { registerCoreRoutes };
