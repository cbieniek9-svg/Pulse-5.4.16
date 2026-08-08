'use strict';

const { addDaysToDateStamp, vendorScheduleWeekday } = require('../store-time.cjs');
const { listActiveMessages, getHandoffForReportDate } = require('../comms-center.cjs');
const { filterPendingExpectedForStoreDate } = require('../expected-orders-day.cjs');
const {
    riskId,
    severityFromException,
    isTgpVendorName,
    safeAll,
} = require('./helpers.cjs');

function collectSystemRisks({
    db,
    storeDate,
    storeWeekday,
    kpis,
    settings,
    managerExceptions,
    reportActions,
    orderDayBriefing,
    directionOrderDay,
    killWarnings,
    getStoreDateStamp,
}) {
    const risks = [];
    const seen = new Set();

    const push = (risk) => {
        const id = riskId(risk);
        if (seen.has(id)) return;
        seen.add(id);
        risks.push({ ...risk, id });
    };

    (managerExceptions || []).forEach((ex) => {
        const taskId = ex.kind === 'task' && String(ex.item_key || '').startsWith('task:')
            ? String(ex.item_key).slice(5)
            : '';
        push({
            kind: ex.kind,
            severity: severityFromException(ex),
            title: ex.title,
            detail: ex.detail,
            meta: ex.meta || '',
            owner_hint: ex.meta || '',
            item_key: ex.item_key || '',
            task_id: taskId,
        });
    });

    (reportActions || []).forEach((a) => {
        if ((managerExceptions || []).some((ex) => ex.title === a.title)) return;
        const kind = a.kind || 'action';
        if (kind === 'tasks_open' || kind === 'orders_open') return;
        push({
            kind,
            severity: a.priority === 'urgent' ? 'urgent' : (a.priority === 'warn' ? 'warn' : 'info'),
            title: a.title,
            detail: a.detail,
            meta: a.meta || '',
            owner_hint: '',
        });
    });

    (killWarnings || []).slice(0, 8).forEach((k) => {
        const days = Number(k.days_until || 0);
        push({
            kind: 'expiry_7d',
            severity: days <= 2 ? 'warn' : 'info',
            title: 'EXPIRY WITHIN 7 DAYS',
            detail: `${k.zone}: ${k.item} (${days}d)`,
            meta: k.kill_date || '',
            owner_hint: '',
        });
    });

    // OOS/hole counts are manager-report-only. Do not turn OOS into
    // floor-facing Daily Direction risk items.

    const scheduleWeekday = vendorScheduleWeekday(storeWeekday, storeDate);
    const vendors = db.all('SELECT vendor FROM vendor_schedule WHERE day=? ORDER BY vendor', scheduleWeekday || '');
    if (vendors.length) {
        const pendingRows = filterPendingExpectedForStoreDate(
            db.all(`
                SELECT vendor, expected_day, exp_id FROM expected_orders
                WHERE category!='hardware' AND status='Pending' AND arrived=0
            `),
            storeDate,
            scheduleWeekday,
            getStoreDateStamp,
        );
        const pending = pendingRows.map((r) => r.vendor);
        const list = vendors.map((v) => v.vendor).join(', ');
        push({
            kind: 'receiving',
            severity: 'info',
            title: 'VENDORS SCHEDULED TODAY',
            detail: list,
            meta: pending.length ? `${pending.length} still pending arrival` : 'Queue ready',
            owner_hint: 'Receiving',
        });
    }

    if (directionOrderDay?.is_order_day) {
        const exp = orderDayBriefing?.expected_pieces;
        const band = exp?.avg != null
            ? `${exp.avg} pcs expected`
            : 'TGP day detected from store activity';
        const meta = orderDayBriefing?.expected_staff != null
            ? `Typical staff: ${orderDayBriefing.expected_staff}`
            : (directionOrderDay?.sources?.length ? `Detected by: ${directionOrderDay.sources.join(', ')}` : '');
        push({
            kind: 'order_day',
            severity: 'info',
            title: 'TGP ORDER DAY',
            detail: band,
            meta,
            owner_hint: '',
        });
    }

    if (kpis?.shift_active && !settings?.Order_End) {
        push({
            kind: 'order_running',
            severity: 'warn',
            title: 'ORDER CLOCK RUNNING',
            detail: 'Run FINISH when the order completes',
            meta: kpis.shift_elapsed || '',
            owner_hint: '',
        });
    }

    try {
        const pinned = listActiveMessages(db, { lane: 'pinned', limit: 3 });
        pinned.filter((m) => m.source === 'human').forEach((m) => {
            push({
                kind: 'pinned_note',
                severity: 'info',
                title: 'PINNED NOTE',
                detail: String(m.body || '').slice(0, 120),
                meta: m.posted_by || '',
                owner_hint: '',
            });
        });
    } catch (_) { /* optional */ }

    const yesterday = addDaysToDateStamp(storeDate, -1);
    try {
        const handoff = getHandoffForReportDate(db, yesterday);
        (handoff?.messages || []).slice(0, 2).forEach((m) => {
            push({
                kind: 'prior_handoff',
                severity: 'info',
                title: 'PRIOR-DAY HANDOFF',
                detail: `${m.lane}: ${String(m.body || '').slice(0, 100)}`,
                meta: m.posted_by || '',
                owner_hint: '',
            });
        });
    } catch (_) { /* optional */ }

    return risks;
}

function orderRisks(risks, riskOrder, hiddenIds) {
    const hidden = new Set(hiddenIds || []);
    const visible = (risks || []).filter((r) => !hidden.has(r.id));
    if (!riskOrder?.length) return visible;
    const byId = Object.fromEntries(visible.map((r) => [r.id, r]));
    const ordered = riskOrder.map((id) => byId[id]).filter(Boolean);
    visible.forEach((r) => {
        if (!ordered.find((o) => o.id === r.id)) ordered.push(r);
    });
    return ordered;
}

module.exports = {
    collectSystemRisks,
    orderRisks,
};
