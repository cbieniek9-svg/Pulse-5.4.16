'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildTaskPlanningSummary,
    buildReportActions,
    buildReportKpiStrip,
} = require('../src/lib/reports-analytics.cjs');
const { assembleReportsPayload } = require('../src/dal/reports-payload.cjs');

test('buildTaskPlanningSummary computes bias by task type', () => {
    const summary = buildTaskPlanningSummary([
        { task_detail: 'FIFO Audit A1', est_mins: 15, actual_mins: 30 },
        { task_detail: 'FIFO Audit A2', est_mins: 15, actual_mins: 25 },
        { task_detail: 'Check cooler tags', est_mins: 10, actual_mins: 10 },
    ]);
    assert.equal(summary.sample_count, 3);
    assert.ok(summary.overall);
    assert.equal(summary.overall.bias_mins, 8.3);
    const fifo = summary.by_type.find((r) => r.task_type === 'FIFO Audit');
    assert.ok(fifo);
    assert.equal(fifo.status, 'under_estimated');
});

test('buildReportActions merges exceptions and live gaps', () => {
    const actions = buildReportActions({
        manager_exceptions: [{
            kind: 'missing_finish',
            title: 'MISSING FINISH YESTERDAY',
            detail: 'No archive',
            meta: 'Run FINISH',
        }],
        shift: { tasks_open: 3, orders_open: 1, kill_dates_due: 2 },
        order_weekly_scorecard: { order_days: 0 },
        order_today: { start: '2026-05-19T10:00:00.000Z', end: '' },
        reportDate: '2026-05-19',
        liveStoreDate: '2026-05-19',
        isLiveToday: true,
    });
    assert.ok(actions.some((a) => a.kind === 'missing_finish'));
    assert.ok(actions.some((a) => a.kind === 'order_running'));
    assert.ok(actions.some((a) => a.kind === 'tasks_open'));
    assert.ok(actions.some((a) => a.kind === 'scorecard_empty'));
});

test('buildReportsLiveContext normalizes uppercase store weekday', () => {
    const { buildReportsLiveContext, normalizeStoreWeekday } = require('../src/lib/reports-analytics.cjs');
    assert.equal(normalizeStoreWeekday('TUESDAY', '2026-05-19'), 'Tuesday');
    const ctx = buildReportsLiveContext(
        {
            getSettings: () => ({}),
            get: () => ({ grocery: 0, frozen: 0, hardware: 0, staff: 1 }),
        },
        {
            reportDate: '2026-05-19',
            liveStoreDate: '2026-05-19',
            getStoreClockPayload: () => ({ storeWeekday: 'TUESDAY', storeTime: '09:30' }),
        },
    );
    assert.equal(ctx.clock.storeWeekday, 'Tuesday');
    assert.equal(ctx.isLiveToday, true);
});

test('historical report date survives rhythm advisor on legacy task schema', () => {
    const payload = assembleReportsPayload({
        targetDb: {
            getSettings: () => ({ Cases_Per_Hour: '55' }),
            get(sql, ...params) {
                if (sql.includes('FROM counts')) return { id: 1, grocery: 0, frozen: 0, hardware: 0, staff: 1 };
                if (sql.includes('SUM(pieces)')) return { t: 0 };
                if (sql.includes('rhythm_tasks') && sql.includes('TGP Order')) return null;
                if (sql.includes('shift_order_history') && sql.includes('WHERE store_date')) return {};
                if (sql.includes('COUNT(*)')) return { c: 0 };
                if (sql.includes("date(?, '-1 day')")) return { d: '2026-05-11' };
                if (sql.includes('comms_handoff_archive')) return undefined;
                return {};
            },
            all(sql) {
                if (sql.includes('FROM shift_order_history')) return [];
                if (sql.includes('FROM rhythm_tasks')) {
                    return [{ id: 'r1', day: 'Tuesday', detail: 'Backstock sweep', priority: 'Routine', zone: 'General', est_mins: 20 }];
                }
                return [];
            },
        },
        APP_VERSION: '4.2.2',
        liveStoreDate: '2026-05-19',
        queryDate: '2026-05-12',
        getStoreClockPayload: () => ({ storeWeekday: 'TUESDAY', storeTime: '10:00' }),
        getHeatMap: () => ({}),
    });

    assert.equal(payload.meta.reportDate, '2026-05-12');
    assert.ok(payload.rhythm_load_advisor);
    assert.equal(payload.rhythm_load_advisor.weekday, 'Tuesday');
});

test('buildReportKpiStrip surfaces urgent action count', () => {
    const strip = buildReportKpiStrip({
        shift: { tasks_completed: 12, tasks_open: 4, oos_logged: 5 },
        order_metrics: { total_pieces: 520, adjusted_per_person_pph: 42.1 },
        order_weekly_scorecard: { order_days: 3, overall: { avg_adj_pph: 38.5 } },
        manager_exceptions: [{ kind: 'pull' }],
        report_actions: [
            { priority: 'urgent' },
            { priority: 'warn' },
        ],
        isLiveToday: true,
    });
    assert.equal(strip.actions_urgent, 1);
    assert.equal(strip.actions_warn, 1);
    assert.equal(strip.tasks_completed, 12);
    assert.equal(strip.scorecard_days, 3);
});
