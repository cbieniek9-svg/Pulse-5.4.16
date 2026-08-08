'use strict';

const { assertPeriodEditable } = require('../../lib/edmonton-receiving-period-controls.cjs');
const { canAccessFinancialLog } = require('../../lib/edmonton-receiving-shadow.cjs');

/**
 * Shared auth/permission guards for receiving HTTP routes.
 * @param {object} ctx
 */
function createReceivingGuards(ctx) {
    const { fail, requireSession, db } = ctx;

    const requireReceivingAuth = (req, res) => {
        const session = requireSession(req, res, false);
        if (!session) return null;
        return session;
    };

    const requireReceivingPermission = (req, res) => {
        const session = requireReceivingAuth(req, res);
        if (!session) return null;
        const staff = db.findStaffByName(session.name);
        const perms = String(staff?.permissions || '').split(',').filter(Boolean);
        const { isManagerRole } = require('../../lib/staff-permissions.cjs');
        if (!isManagerRole(session.role) && !perms.includes('receiving')) {
            fail(res, 403, 'Manager or receiving permission required.');
            return null;
        }
        return session;
    };

    const requireManagerOnly = (req, res) => {
        const session = requireReceivingAuth(req, res);
        if (!session) return null;
        const { isManagerRole } = require('../../lib/staff-permissions.cjs');
        if (!isManagerRole(session.role)) {
            fail(res, 403, 'Manager role required.');
            return null;
        }
        return session;
    };

    const guardPeriodEditable = (anchorDateOrPeriodStart) => {
        assertPeriodEditable(db, anchorDateOrPeriodStart);
    };

    const requireFinancialLogAccess = (req, res, session) => {
        if (!canAccessFinancialLog(db, session.name)) {
            fail(res, 403, 'Financial Log is in shadow mode and not enabled for your account.');
            return false;
        }
        return true;
    };

    const requireFinancialLogSession = (req, res) => {
        const session = requireReceivingPermission(req, res);
        if (!session) return null;
        if (!requireFinancialLogAccess(req, res, session)) return null;
        return session;
    };

    const requireFinancialAdmin = (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return null;
        if (!requireFinancialLogAccess(req, res, session)) return null;
        return session;
    };

    return {
        requireReceivingAuth,
        requireReceivingPermission,
        requireManagerOnly,
        guardPeriodEditable,
        requireFinancialLogAccess,
        requireFinancialLogSession,
        requireFinancialAdmin,
    };
}

module.exports = { createReceivingGuards };
