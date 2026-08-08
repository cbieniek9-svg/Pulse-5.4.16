'use strict';

const CORE4_FAIL_CHECKS = [
    { key: 'front_edge_pass', label: 'FRONT-EDGE', time: 20 },
    { key: 'tag_integrity_pass', label: 'TAG INTEGRITY', time: 15 },
    { key: 'hole_strategy_pass', label: 'HOLE STRATEGY', time: 10 },
    { key: 'clearances_pass', label: 'FIXTURE CLEARANCE', time: 15 },
];

const VALID_ZONES = new Set(['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'General']);

function readZoneOwnership(db) {
    try {
        return JSON.parse(db.get("SELECT setting_value FROM settings WHERE setting_name='Zone_Ownership'")?.setting_value || '{}');
    } catch (_) {
        return {};
    }
}

function resolveZoneOwner(db, zoneName) {
    const owners = readZoneOwnership(db);
    const raw = String(owners[zoneName] || '').trim();
    if (!raw) return 'Unassigned';
    const staff = db.get('SELECT name, active FROM staff WHERE name = ?', raw);
    return staff?.active === 1 ? String(staff.name).trim() : 'Unassigned';
}

function validatePremiumZoneRecovery(payload) {
    const errors = [];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return ['check payload must be a JSON object.'];
    }
    const zone = String(payload.zone_name || '').trim();
    if (!zone || !VALID_ZONES.has(zone)) errors.push('zone_name must be Zone 1–4 or General.');
    const premium = String(payload.premium_name || '').trim();
    if (!premium) errors.push('premium_name is required.');
    if (premium.length > 200) errors.push('premium_name too long.');
    if (payload.notes !== undefined && typeof payload.notes !== 'string') errors.push('notes must be a string.');
    if (payload.notes && payload.notes.length > 1000) errors.push('notes exceeds 1000 characters.');
    CORE4_FAIL_CHECKS.forEach((f) => {
        const v = payload[f.key];
        if (v !== 0 && v !== 1 && v !== '0' && v !== '1') {
            errors.push(`${f.key} must be 0 or 1.`);
        }
    });
    const failCount = CORE4_FAIL_CHECKS.filter((f) => Number(payload[f.key]) === 0).length;
    if (!failCount) errors.push('Mark at least one Core 4 point as FAIL to create recovery tasks.');
    return errors;
}

/**
 * Premium aisle walk — creates board recovery tasks only (no supervisor homebase_audits row).
 * @returns {{ tasksCreated: number, assignee: string, zone_name: string }}
 */
function createPremiumZoneRecoveryTasks(db, payload, actorName) {
    const errors = validatePremiumZoneRecovery(payload);
    if (errors.length) {
        const err = new Error(errors.join(' '));
        err.status = 400;
        throw err;
    }

    const zone_name = String(payload.zone_name).trim();
    const premium_name = String(payload.premium_name).trim();
    const assignee = resolveZoneOwner(db, zone_name);
    const now = new Date().toISOString();
    const base = require('crypto').randomUUID().replace(/-/g, '').slice(0, 8);
    let tasksCreated = 0;

    db.transaction(() => {
        CORE4_FAIL_CHECKS.forEach((f, i) => {
            if (Number(payload[f.key]) !== 0) return;
            const noteSuffix = payload.notes ? ` — ${String(payload.notes).trim().slice(0, 120)}` : '';
            db.run(
                'INSERT INTO tasks (task_id, task_detail, status, priority, zone, assigned_to, est_mins, time_submitted) VALUES (?,?,?,?,?,?,?,?)',
                `T-PREM-${base}-${i}`,
                `RECOVERY: ${f.label} (${premium_name})${noteSuffix}`,
                'Open',
                'High',
                zone_name,
                assignee,
                f.time,
                now,
            );
            tasksCreated += 1;
        });
        db.upsertAudit(
            require('crypto').randomUUID(),
            now,
            actorName,
            'premium_zone_recovery',
            'tasks',
            JSON.stringify({ zone: zone_name, premium: premium_name, tasks: tasksCreated, assignee }),
        );
    })();

    return { tasksCreated, assignee, zone_name, premium_name };
}

module.exports = {
    CORE4_FAIL_CHECKS,
    VALID_ZONES,
    resolveZoneOwner,
    validatePremiumZoneRecovery,
    createPremiumZoneRecoveryTasks,
};
