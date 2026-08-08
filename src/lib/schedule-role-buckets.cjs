'use strict';

/** Default HomeBase / import schedule text → rhythm assignment bucket. First match wins. */
const DEFAULT_SCHEDULE_ROLE_RULES = [
    { label: 'Receiving (REC)', match: '\\brec\\b|receiv|receiving', bucket: 'rec' },
    { label: 'Bakery', match: 'bakery|bake', bucket: 'bakery' },
    {
        label: 'Stock / Float / Floor',
        match: 'stock\\s*\\/?\\s*float|stock\\/float|\\bfloat\\b|\\bstock\\b|\\bstk\\b|home\\s*base|homebase|center\\s*store|grocery|aisle|floor',
        bucket: 'stock_float',
    },
    { label: 'Freezer (floor work)', match: 'freezer|frozen', bucket: 'stock_float' },
    { label: 'Supervisor', match: 'supervisor|\\bsupv\\b|\\bsup\\b', bucket: 'supervisor' },
    { label: 'Premium / Shift Lead', match: 'premium|prem\\b|shift\\s*lead|shiftlead|zone\\s*prem', bucket: 'premium' },
    { label: 'Manager (shift lead)', match: '\\bmanager\\b|\\bmgr\\b', bucket: 'premium', exclude: 'store\\s*manager' },
    { label: 'Cash', match: 'open\\s*cash|clo\\s*cash|\\bcash\\b|till', bucket: 'cash' },
    { label: 'Customer Service', match: 'cust\\s*serv|\\bcs\\b|customer', bucket: 'cs' },
];

const VALID_BUCKETS = new Set([
    'rec', 'stock_float', 'bakery', 'supervisor', 'premium', 'cash', 'cs', 'other',
]);

/** Buckets that can be set on a rhythm task (plus auto / shift_lead smart rule). */
const RHYTHM_ASSIGN_BUCKETS = [
    'auto',
    'shift_lead',
    'supervisor',
    'premium',
    'stock_float',
    'bakery',
    'rec',
    'cash',
    'cs',
    'other',
];

function parseCustomRules(raw) {
    try {
        const parsed = JSON.parse(raw || '[]');
        if (!Array.isArray(parsed)) return null;
        return parsed.filter((r) => r && r.match && r.bucket && VALID_BUCKETS.has(r.bucket));
    } catch (_) {
        return null;
    }
}

function resolveRules(customRulesJson) {
    const custom = parseCustomRules(customRulesJson);
    return custom?.length ? custom : DEFAULT_SCHEDULE_ROLE_RULES;
}

function matchRules(text, rules) {
    const s = String(text || '').trim().toLowerCase();
    if (!s) return 'other';
    for (const rule of rules) {
        if (rule.exclude && new RegExp(rule.exclude, 'i').test(s)) continue;
        if (new RegExp(rule.match, 'i').test(s)) return rule.bucket;
    }
    return 'other';
}

/**
 * Department is the column a manager edits in Shift Roster, so a department that classifies
 * cleanly wins outright. Only when it does not ('CLOSER', 'OUTSIDE', blank) do we fall back to
 * department + role together — otherwise an imported job title like
 * 'FT Centre Store Clerk/Cashier' out-votes an explicit 'Customer Service' assignment.
 */
function classifyShift(department, role, customRulesJson) {
    const rules = resolveRules(customRulesJson);
    const byDepartment = matchRules(department, rules);
    if (byDepartment !== 'other') return byDepartment;
    return matchRules(`${department || ''} ${role || ''}`, rules);
}

function bucketLabel(bucket) {
    const labels = {
        rec: 'Receiving (REC)',
        stock_float: 'Stock / Float',
        bakery: 'Bakery',
        supervisor: 'Supervisor',
        premium: 'Premium / Shift Lead',
        cash: 'Cash',
        cs: 'Customer Service',
        other: 'Other',
        shift_lead: 'Supervisor → Premium (walks/huddle)',
        auto: 'Auto (from task text)',
    };
    return labels[bucket] || bucket;
}

/**
 * Ensure stored Schedule_Role_Buckets JSON includes a supervisor rule.
 * @param {object[]} rules
 * @returns {object[]}
 */
function ensureSupervisorRule(rules) {
    const list = Array.isArray(rules) ? rules.slice() : [];
    const hasSup = list.some((r) => r && r.bucket === 'supervisor');
    if (hasSup) return list;
    const premiumIdx = list.findIndex((r) => r && r.bucket === 'premium');
    const rule = {
        label: 'Supervisor',
        match: 'supervisor|\\bsupv\\b|\\bsup\\b',
        bucket: 'supervisor',
    };
    if (premiumIdx >= 0) list.splice(premiumIdx, 0, rule);
    else list.push(rule);
    return list;
}

module.exports = {
    DEFAULT_SCHEDULE_ROLE_RULES,
    VALID_BUCKETS,
    RHYTHM_ASSIGN_BUCKETS,
    parseCustomRules,
    resolveRules,
    matchRules,
    classifyShift,
    bucketLabel,
    ensureSupervisorRule,
};
