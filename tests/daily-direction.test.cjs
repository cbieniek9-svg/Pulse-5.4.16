'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    deriveDayStatus,
    isTgpVendorName,
    resolveDirectionOrderDay,
    repairPostedDailyDirectionOrderDay,
    buildDefaultFloorMessage,
    buildDailyDirectionDraft,
    loadDailyDirectionReportView,
    loadDailyDirectionFloor,
    saveDailyDirectionEdits,
    approveDailyDirection,
    buildAmendmentTriggers,
    buildAmendmentSuggestion,
    buildDefaultShiftUpdateMessage,
    fingerprintTriggers,
    postShiftUpdate,
    updatePostedDailyDirection,
    ignoreAmendmentSuggestion,
    dismissAmendmentSuggestion,
    syncMustWinsWithOpenBoard,
} = require('../src/lib/daily-direction.cjs');

function mockDb(overrides = {}) {
    const tables = {
        daily_direction: [],
        shift_updates: [],
        tasks: [],
        comms_messages: [],
        vendor_schedule: [],
        oos: [],
        expected_orders: [],
        kill_dates: [],
        settings: [],
    };
    const state = { ...tables, ...overrides.tables };

    return {
        get(sql, ...params) {
            if (sql.includes('daily_direction')) {
                return state.daily_direction.find((r) => r.store_date === params[0]) || null;
            }
            if (sql.includes('vendor_schedule')) {
                return state.vendor_schedule[0] || null;
            }
            if (sql.includes('Daily direction huddle')) {
                const storeDate = params.length >= 2 ? String(params[1]) : null;
                return state.tasks.find((t) => {
                    if (t.status !== 'Open') return false;
                    if (!String(t.task_detail || '').includes('Daily direction huddle')
                        && !String(t.task_detail || '').toLowerCase().includes('huddle')) {
                        // approve test uses exact huddle detail; allow any open when detail missing for legacy fixtures
                        if (t.task_detail && !String(t.task_detail).includes('huddle')) return false;
                    }
                    if (storeDate && t.time_submitted && String(t.time_submitted).slice(0, 10) !== storeDate) {
                        return false;
                    }
                    return true;
                }) || null;
            }
            if (sql.includes('shift_updates')) {
                if (sql.includes('MAX(sequence_num)')) {
                    const rows = state.shift_updates.filter((r) => r.store_date === params[0]);
                    return { m: rows.reduce((m, r) => Math.max(m, r.sequence_num), 0) };
                }
                return state.shift_updates.filter((r) => r.store_date === params[0]);
            }
            if (sql.includes('shift_order_history')) {
                return (state.shift_order_history || []).find((r) => r.store_date === params[0]) || null;
            }
            if (sql.includes('FROM tasks') && sql.includes('T-TGP')) {
                const storeDate = params[0];
                return state.tasks.find((t) => {
                    const isTgpWorkTask = String(t.task_id || '').startsWith('T-TGP-');
                    if (!isTgpWorkTask) return false;
                    return [t.time_submitted, t.start_time, t.time_closed]
                        .some((v) => String(v || '').slice(0, 10) === storeDate);
                }) || null;
            }
            if (sql.includes('comms_messages') && sql.includes('dedupe_key')) {
                return null;
            }
            return null;
        },
        all(sql, ...params) {
            if (sql.includes('vendor_schedule')) return state.vendor_schedule;
            if (sql.includes('FROM oos')) return state.oos;
            if (sql.includes('expected_orders')) {
                if (sql.includes('TGP') || sql.includes('THE GROCERY PEOPLE')) {
                    const storeDate = params[0];
                    return state.expected_orders.filter((r) => {
                        const vendor = String(r.vendor || '').toUpperCase();
                        const datedActivity = [r.arrived_at, r.departed_at, r.time_closed]
                            .some((v) => String(v || '').slice(0, 10) === storeDate);
                        return datedActivity && (vendor.startsWith('TGP') || vendor.startsWith('THE GROCERY PEOPLE'));
                    });
                }
                if (sql.includes('Pending')) return state.expected_orders;
                return state.expected_orders;
            }
            if (sql.includes('shift_order_history')) return state.shift_order_history || [];
            if (sql.includes('kill_dates') && sql.includes('days_until')) return state.kill_warnings || [];
            if (sql.includes('shift_updates')) {
                return state.shift_updates.filter((r) => r.store_date === params[0]);
            }
            if (sql.includes('comms_messages')) return state.comms_messages;
            if (sql.includes('FROM tasks')
                && sql.includes("status = 'Open'")
                && (sql.includes("priority = 'Urgent'") || sql.includes("priority='Urgent'"))) {
                return (state.tasks || []).filter((t) => (
                    t.status === 'Open'
                    && (t.priority === 'Urgent' || t.priority === 'High')
                    && !String(t.task_id || '').startsWith('AUTO-PULL')
                ));
            }
            return [];
        },
        run(sql, ...params) {
            if (sql.includes('UPDATE daily_direction SET')
                && sql.includes('posted_snapshot_json = ?')
                && sql.includes('WHERE store_date = ?')
                && params.length === 5) {
                const row = state.daily_direction.find((r) => r.store_date === params[4]);
                if (row) {
                    row.floor_message = params[0];
                    row.posted_snapshot_json = params[1];
                    row.updated_at = params[2];
                    row.updated_by = params[3];
                }
            }
            if (sql.includes('INSERT INTO daily_direction')) {
                state.daily_direction.push({
                    store_date: params[0],
                    walk_notes_json: params[1],
                    must_wins_json: params[2],
                    status_override: params[3],
                    hidden_risk_ids_json: params[4],
                    risk_order_json: params[5],
                    floor_message: params[6],
                    floor_message_edited: params[7],
                    manager_only_notes: params[8],
                    updated_at: params[9],
                    updated_by: params[10],
                });
            }
            // Silent board sync (posted): must_wins, floor_message, snapshot, at, by, store_date
            if (sql.includes('UPDATE daily_direction SET')
                && sql.includes('must_wins_json = ?')
                && sql.includes('posted_snapshot_json = ?')
                && params.length === 6) {
                const row = state.daily_direction.find((r) => r.store_date === params[5]);
                if (row) {
                    row.must_wins_json = params[0];
                    row.floor_message = params[1];
                    row.posted_snapshot_json = params[2];
                    row.updated_at = params[3];
                    row.updated_by = params[4];
                }
            // Silent board sync (draft): must_wins, floor_message, at, by, store_date
            } else if (sql.includes('UPDATE daily_direction SET')
                && sql.includes('must_wins_json = ?')
                && !sql.includes('posted_snapshot_json')
                && !sql.includes('status_override')
                && params.length === 5) {
                const row = state.daily_direction.find((r) => r.store_date === params[4]);
                if (row) {
                    row.must_wins_json = params[0];
                    row.floor_message = params[1];
                    row.updated_at = params[2];
                    row.updated_by = params[3];
                }
            } else if (sql.includes('UPDATE daily_direction SET') && sql.includes('must_wins_json = ?')) {
                const row = state.daily_direction.find((r) => r.store_date === params[8]);
                if (row) {
                    row.floor_message = params[0];
                    row.floor_message_edited = 1;
                    row.status_override = params[1];
                    row.must_wins_json = params[2];
                    row.walk_notes_json = params[3];
                    row.manager_only_notes = params[4];
                    row.posted_snapshot_json = params[5];
                    row.updated_at = params[6];
                    row.updated_by = params[7];
                }
            }
            if (sql.includes('UPDATE daily_direction SET') && sql.includes('floor_message = ?') && sql.includes('posted_snapshot_json')) {
                const row = state.daily_direction.find((r) => r.store_date === params[5]);
                if (row) {
                    row.floor_message = params[0];
                    row.floor_message_edited = params[1];
                    row.posted_snapshot_json = params[2];
                    row.shift_update_draft_json = '';
                    row.updated_at = params[3];
                    row.updated_by = params[4];
                }
            }
            if (sql.includes('UPDATE daily_direction SET') && sql.includes('posted_at')) {
                const row = state.daily_direction.find((r) => r.store_date === params[7]);
                if (row) {
                    row.posted_at = params[0];
                    row.posted_by = params[1];
                    row.posted_msg_id = params[2];
                    row.posted_snapshot_json = params[3];
                }
            }
            if (sql.includes('UPDATE tasks SET status')) {
                const taskId = params[2];
                const task = state.tasks.find((t) => t.task_id === taskId) || state.tasks[0];
                if (task) {
                    task.status = 'Closed';
                    task.closed_by = params[0];
                }
            }
            if (sql.includes('INSERT INTO shift_updates')) {
                state.shift_updates.push({
                    store_date: params[0],
                    sequence_num: params[1],
                    message: params[2],
                    triggers_json: params[3],
                    posted_at: params[4],
                    posted_by: params[5],
                    posted_msg_id: params[6],
                    snapshot_json: params[7],
                });
            }
            if (sql.includes('amendment_snoozed_until') || sql.includes('amendment_dismissed_fingerprint')) {
                const row = state.daily_direction.find((r) => r.store_date === params[params.length - 1]);
                if (row && sql.includes('amendment_snoozed_until')) row.amendment_snoozed_until = params[0];
                if (row && sql.includes('amendment_dismissed_fingerprint')) row.amendment_dismissed_fingerprint = params[0];
            }
            if (sql.includes('INSERT INTO comms_messages')) {
                state.comms_messages.push({ msg_id: params[0], lane: params[1], body: params[2] });
            }
        },
        getSettings: () => ({ Message_Center_Enabled: '1', Zone_Ownership: '{"Zone 2":"Luke"}' }),
        _tasks: state.tasks,
        ...overrides,
    };
}

test('deriveDayStatus returns green when no risks', () => {
    assert.equal(deriveDayStatus([]), 'green');
});

test('deriveDayStatus returns red for missing FINISH', () => {
    assert.equal(deriveDayStatus([{ kind: 'missing_finish', severity: 'urgent' }]), 'red');
});

test('deriveDayStatus returns yellow for warn-level risks', () => {
    assert.equal(deriveDayStatus([{ kind: 'zone', severity: 'warn' }]), 'yellow');
});

test('buildDefaultFloorMessage includes status and must-wins', () => {
    const msg = buildDefaultFloorMessage({
        status: 'yellow',
        weekday: 'Sunday',
        isOrderDay: true,
        mustWins: [{ text: 'Luke: Zone 2 pulls' }],
        vendors: [{ vendor: 'ABC' }],
    });
    assert.match(msg, /TODAY: YELLOW/);
    assert.match(msg, /Luke: Zone 2 pulls/);
    assert.match(msg, /ABC/);
});


test('isTgpVendorName detects TGP aliases', () => {
    assert.equal(isTgpVendorName('TGP Grocery'), true);
    assert.equal(isTgpVendorName('The Grocery People'), true);
    assert.equal(isTgpVendorName('Sysco'), false);
});

test('resolveDirectionOrderDay treats actual TGP receiving activity as TGP days even when briefing is false', () => {
    const db = mockDb({
        tables: {
            expected_orders: [{
                exp_id: 'E-1',
                vendor: 'TGP Grocery',
                expected_day: 'Sunday',
                category: 'general',
                status: 'Arrived',
                arrived_at: '2026-06-07T08:15:00Z',
            }],
        },
    });

    const resolved = resolveDirectionOrderDay(db, {
        storeDate: '2026-06-07',
        storeWeekday: 'Sunday',
        kpis: {},
        settings: {},
        orderDayBriefing: { is_order_day: false },
    });

    assert.equal(resolved.is_order_day, true);
    assert.ok(resolved.sources.includes('received_tgp'));
});

test('buildDailyDirectionDraft labels actual TGP receiving days correctly when briefing is blank', () => {
    const db = mockDb({
        tables: {
            expected_orders: [{
                exp_id: 'E-1',
                vendor: 'TGP Grocery',
                expected_day: 'Sunday',
                category: 'general',
                status: 'Arrived',
                arrived_at: '2026-06-07T08:15:00Z',
            }],
        },
    });

    const draft = buildDailyDirectionDraft(db, {
        storeDate: '2026-06-07',
        clock: { storeWeekday: 'Sunday', storeTime: '08:00' },
        kpis: {},
        settings: {},
        managerExceptions: [],
        reportActions: [],
        orderDayBriefing: { is_order_day: false },
        killWarnings: [],
    });

    assert.equal(draft.day_context.is_order_day, true);
    assert.match(draft.floor_message, /TGP Order Day/);
    assert.ok(draft.system_risks.some((r) => r.title === 'TGP ORDER DAY'));
});

test('buildDailyDirectionDraft ignores pending scheduled TGP rows and rhythm TGP task labels on non-TGP weekdays', () => {
    const db = mockDb({
        tables: {
            expected_orders: [{
                exp_id: 'E-1',
                vendor: 'TGP Grocery',
                expected_day: '2026-06-08',
                category: 'general',
                status: 'Pending',
            }],
            tasks: [{
                task_id: 'T-123',
                task_detail: 'TGP Order',
                status: 'Open',
                time_submitted: '2026-06-08T06:00:00Z',
            }],
        },
    });

    const draft = buildDailyDirectionDraft(db, {
        storeDate: '2026-06-08',
        clock: { storeWeekday: 'Monday', storeTime: '08:00' },
        kpis: {},
        settings: {},
        managerExceptions: [],
        reportActions: [],
        orderDayBriefing: { is_order_day: true },
        killWarnings: [],
    });

    assert.equal(draft.day_context.is_order_day, false);
    assert.match(draft.floor_message, /Non-TGP Day/);
    assert.equal(draft.system_risks.some((r) => r.title === 'TGP ORDER DAY'), false);
});

test('resolveDirectionOrderDay treats TGP work tasks as order-day proof', () => {
    const db = mockDb({
        tables: {
            tasks: [{
                task_id: 'T-TGP-E-1',
                task_detail: 'Work the TGP order',
                status: 'Open',
                time_submitted: '2026-06-07T11:30:00Z',
            }],
        },
    });

    const resolved = resolveDirectionOrderDay(db, {
        storeDate: '2026-06-07',
        storeWeekday: 'Sunday',
        kpis: {},
        settings: {},
        orderDayBriefing: { is_order_day: false },
    });

    assert.equal(resolved.is_order_day, true);
    assert.ok(resolved.sources.includes('tgp_work_task'));
});


test('resolveDirectionOrderDay ignores recurring cadence without dated TGP activity', () => {
    const db = mockDb({
        tables: {
            vendor_schedule: [{ day: 'Monday', vendor: 'TGP Grocery' }],
        },
    });

    const resolved = resolveDirectionOrderDay(db, {
        storeDate: '2026-06-08',
        storeWeekday: 'Monday',
        kpis: {},
        settings: {},
        orderDayBriefing: { is_order_day: true },
    });

    assert.equal(resolved.is_order_day, false);
    assert.deepEqual(resolved.sources, []);
});

test('resolveDirectionOrderDay ignores stale order clocks and stale open TGP tasks', () => {
    const db = mockDb({
        tables: {
            tasks: [{
                task_id: 'T-TGP-OLD',
                task_detail: 'TGP ORDER follow-up',
                status: 'Open',
                time_submitted: '2026-06-07T09:00:00Z',
            }],
        },
    });

    const resolved = resolveDirectionOrderDay(db, {
        storeDate: '2026-06-08',
        storeWeekday: 'Monday',
        kpis: { shift_active: true },
        settings: { Order_Start: '2026-06-07T08:00:00Z', Order_End: '' },
        orderDayBriefing: { is_order_day: false },
    });

    assert.equal(resolved.is_order_day, false);
    assert.deepEqual(resolved.sources, []);
});


test('buildDailyDirectionDraft merges saved must-wins', () => {
    const db = mockDb({
        tables: {
            daily_direction: [{
                store_date: '2026-06-07',
                walk_notes_json: '{"free_text":"Floor rough in A9","flags":{}}',
                must_wins_json: '[{"text":"Luke: endcaps","owner":"Luke"}]',
                status_override: 'red',
                hidden_risk_ids_json: '[]',
                risk_order_json: '[]',
                floor_message: 'Custom message',
                floor_message_edited: 1,
                manager_only_notes: '',
                updated_at: '2026-06-07T10:00:00Z',
                updated_by: 'Manager',
            }],
        },
    });

    const draft = buildDailyDirectionDraft(db, {
        storeDate: '2026-06-07',
        clock: { storeWeekday: 'Sunday', storeTime: '08:00' },
        kpis: {},
        settings: {},
        managerExceptions: [],
        reportActions: [],
        orderDayBriefing: { is_order_day: false },
        killWarnings: [],
    });

    assert.equal(draft.status, 'red');
    assert.equal(draft.must_wins[0].text, 'Luke: endcaps');
    assert.equal(draft.floor_message, 'Custom message');
    assert.equal(draft.walk_notes.free_text, 'Floor rough in A9');
});

test('approveDailyDirection posts floor view only and closes huddle task', () => {
    const db = mockDb({
        tables: {
            tasks: [{
                task_id: 'T-1',
                status: 'Open',
                task_detail: 'Daily direction huddle',
                time_submitted: '2026-06-07T12:00:00.000Z',
            }],
        },
    });

    const result = approveDailyDirection(db, {
        storeDate: '2026-06-07',
        clock: { storeWeekday: 'Sunday' },
        kpis: {},
        settings: { Message_Center_Enabled: '1' },
        managerExceptions: [],
        reportActions: [],
        orderDayBriefing: null,
        killWarnings: [],
        broadcastUpdate: () => {},
    }, {
        storeDate: '2026-06-07',
        actorName: 'Alex',
        floorMessage: 'TODAY: GREEN\nMust-win:\n• Keep floor tight',
        mustWins: [{ text: 'Keep floor tight', owner: '' }],
        statusOverride: 'green',
    });

    assert.equal(result.success, true);
    assert.ok(result.posted_at);
    assert.equal(result.huddle_task_closed, true);
    assert.equal(result.posted_msg_id, null);
    assert.equal(db.all('SELECT FROM comms_messages').length, 0);
});

test('approveDailyDirection does not close yesterday huddle carryover', () => {
    const db = mockDb({
        tables: {
            tasks: [{
                task_id: 'T-OLD',
                status: 'Open',
                task_detail: 'Daily direction huddle',
                time_submitted: '2026-06-06T12:00:00.000Z',
            }],
        },
    });

    const result = approveDailyDirection(db, {
        storeDate: '2026-06-07',
        clock: { storeWeekday: 'Sunday' },
        kpis: {},
        settings: { Message_Center_Enabled: '1' },
        managerExceptions: [],
        reportActions: [],
        orderDayBriefing: null,
        killWarnings: [],
        broadcastUpdate: () => {},
    }, {
        storeDate: '2026-06-07',
        actorName: 'Alex',
        floorMessage: 'TODAY: GREEN',
        mustWins: [],
        statusOverride: 'green',
    });

    assert.equal(result.huddle_task_closed, false);
    assert.equal(db._tasks[0].status, 'Open');
});

test('buildAmendmentTriggers detects pulls and PPH', () => {
    const triggers = buildAmendmentTriggers({
        postedSnapshot: {
            posted_at: '2026-06-07T08:00:00Z',
            system_risks: [{ id: 'pull:Zone 2:item', kind: 'pull', severity: 'urgent' }],
        },
        liveRisks: [{
            id: 'pull:Zone 2:item',
            kind: 'pull',
            severity: 'urgent',
            detail: 'Zone 2: milk',
        }],
        kpis: { shift_active: true, shift_pph: 40, shift_standard_pph: 55 },
        openTasks: [],
        settings: {},
    });
    assert.ok(triggers.some((t) => t.line.includes('Expiry pull')));
    assert.ok(triggers.some((t) => t.line.includes('PPH below target')));
});

test('amendment suggestion hidden when dismissed fingerprint matches', () => {
    const triggers = [{ id: 'pull:a', line: 'Expiry pull still open: Zone 2', severity: 'urgent' }];
    const fp = fingerprintTriggers(triggers);
    const row = {
        posted_at: '2026-06-07T08:00:00Z',
        amendment_dismissed_fingerprint: fp,
    };
    const suggestion = buildAmendmentSuggestion(
        row,
        { posted_at: row.posted_at, system_risks: [] },
        triggers,
        { storeTime: '12:00' },
        null,
    );
    assert.equal(suggestion, null);
});

test('postShiftUpdate records report history and updates visible Daily Direction in place', () => {
    const db = mockDb({
        tables: {
            daily_direction: [{
                store_date: '2026-06-07',
                posted_at: '2026-06-07T08:00:00Z',
                posted_by: 'Alex',
                posted_snapshot_json: '{}',
                amendment_dismissed_fingerprint: '',
            }],
        },
    });

    const triggers = [{ id: 'pph:below_target', line: 'Order PPH below target (40 vs 55)', severity: 'warn' }];
    const result = postShiftUpdate(db, {
        settings: { Message_Center_Enabled: '1' },
        broadcastUpdate: () => {},
    }, {
        storeDate: '2026-06-07',
        actorName: 'Alex',
        message: 'SHIFT UPDATE — 12:00\n• Order PPH below target',
        fingerprint: fingerprintTriggers(triggers),
        triggers,
    });

    assert.equal(result.success, true);
    assert.equal(result.sequence, 1);
    const updates = db.all('SELECT FROM shift_updates WHERE store_date = ?', '2026-06-07');
    assert.equal(updates.length, 1);
    assert.equal(result.posted_msg_id, null);
    const updatedDailyDirection = db.get('SELECT FROM daily_direction WHERE store_date = ?', '2026-06-07');
    const postedSnapshot = JSON.parse(updatedDailyDirection.posted_snapshot_json);
    assert.equal(updatedDailyDirection.floor_message, 'SHIFT UPDATE — 12:00\n• Order PPH below target');
    assert.equal(postedSnapshot.floor_message, 'SHIFT UPDATE — 12:00\n• Order PPH below target');
    assert.equal(postedSnapshot.update_sequence, 1);
    assert.equal(postedSnapshot.last_updated_by, 'Alex');
    const msgs = db.all('SELECT FROM comms_messages');
    assert.equal(msgs.length, 0);
    assert.equal(msgs.some((m) => m.lane === 'ticker'), false);
});

test('updatePostedDailyDirection replaces visible card and preserves must-wins', () => {
    const db = mockDb({
        tables: {
            daily_direction: [{
                store_date: '2026-06-07',
                posted_at: '2026-06-07T08:00:00Z',
                posted_by: 'Alex',
                floor_message: 'TODAY: YELLOW (Monday · Non-TGP Day)',
                posted_snapshot_json: JSON.stringify({
                    status: 'yellow',
                    floor_message: 'TODAY: YELLOW (Monday · Non-TGP Day)',
                    must_wins: [{ text: 'Old win', owner: '' }],
                }),
            }],
        },
    });

    const result = updatePostedDailyDirection(db, { broadcastUpdate: () => {} }, {
        storeDate: '2026-06-07',
        actorName: 'Alex',
        floorMessage: 'TODAY: GREEN (Monday · Non-TGP Day)\nMust-win: Face A1',
        statusOverride: 'green',
        mustWins: [{ text: 'Face A1', owner: '' }, { text: 'Clear dock', owner: '' }],
        walkNotes: { free_text: 'Floor looks good', flags: { floor_rough: false } },
        managerOnlyNotes: 'Watch PPH after lunch',
    });

    assert.equal(result.success, true);
    assert.equal(result.sequence, 1);
    const row = db.get('SELECT FROM daily_direction WHERE store_date = ?', '2026-06-07');
    const snap = JSON.parse(row.posted_snapshot_json);
    assert.equal(snap.status, 'green');
    assert.equal(snap.must_wins.length, 2);
    assert.equal(snap.must_wins[0].text, 'Face A1');
    assert.equal(snap.walk_notes.free_text, 'Floor looks good');
    assert.equal(snap.manager_only_notes, 'Watch PPH after lunch');
    assert.equal(row.floor_message_edited, 1);
});

test('loadDailyDirectionFloor exposes one current Daily Direction card and hides update history', () => {
    const db = mockDb({
        tables: {
            daily_direction: [{
                store_date: '2026-06-07',
                posted_at: '2026-06-07T08:00:00Z',
                posted_by: 'Alex',
                posted_snapshot_json: JSON.stringify({
                    status: 'green',
                    floor_message: 'SHIFT UPDATE — receiving is caught up.',
                    must_wins: [{ text: 'Face Zone 1', owner: 'Sam' }],
                    last_updated_at: '2026-06-07T12:15:00Z',
                    last_updated_by: 'Alex',
                    update_sequence: 1,
                }),
            }],
            shift_updates: [{
                store_date: '2026-06-07',
                sequence_num: 1,
                message: 'SHIFT UPDATE — receiving is caught up.',
                triggers_json: '[]',
                posted_at: '2026-06-07T12:15:00Z',
                posted_by: 'Alex',
                posted_msg_id: null,
                snapshot_json: '{}',
            }],
        },
    });

    const floor = loadDailyDirectionFloor(db, '2026-06-07');
    assert.equal(floor.daily_direction.floor_message, 'SHIFT UPDATE — receiving is caught up.');
    assert.equal(floor.daily_direction.posted_by, 'Alex');
    assert.equal(floor.daily_direction.updated_at, '2026-06-07T12:15:00Z');
    assert.equal(floor.daily_direction.update_count, 1);
    assert.equal(floor.shift_updates.length, 0);
});

test('loadDailyDirectionFloor scrubs stale posted TGP label on non-TGP weekdays', () => {
    const db = mockDb({
        tables: {
            daily_direction: [{
                store_date: '2026-06-08',
                posted_at: '2026-06-08T08:00:00Z',
                posted_by: 'Alex',
                posted_snapshot_json: JSON.stringify({
                    status: 'yellow',
                    floor_message: 'TODAY: YELLOW (Monday · TGP Order Day)\nMust-win:\n• Keep floor tight',
                    day_context: { weekday: 'Monday', is_order_day: true, order_day_sources: ['tgp_task'] },
                    must_wins: [{ text: 'Keep floor tight', owner: '' }],
                }),
            }],
        },
    });

    const floor = loadDailyDirectionFloor(db, '2026-06-08');
    assert.match(floor.daily_direction.floor_message, /Non-TGP Day/);
    assert.doesNotMatch(floor.daily_direction.floor_message, /TGP Order Day/);
});


test('resolveDirectionOrderDay uses Sunday Tuesday Thursday schedule, not the generic order clock', () => {
    const db = mockDb({
        getSettings: () => ({
            Order_Start: '2026-06-10T09:00:00.000Z',
            Order_End: '2026-06-11T02:00:00.000Z',
        }),
    });

    const wednesday = resolveDirectionOrderDay(db, {
        storeDate: '2026-06-10',
        storeWeekday: 'Wednesday',
        settings: db.getSettings(),
        kpis: { shift_active: true },
    });

    const thursday = resolveDirectionOrderDay(db, {
        storeDate: '2026-06-11',
        storeWeekday: 'Thursday',
        settings: db.getSettings(),
        kpis: { shift_active: true },
    });

    assert.equal(wednesday.is_order_day, false);
    assert.equal(wednesday.sources.includes('order_clock_start'), false);
    assert.equal(thursday.is_order_day, true);
    assert.equal(thursday.sources.includes('tgp_weekday_schedule'), true);
});

test('buildDailyDirectionDraft scrubs posted TGP label on Wednesday even when the order clock is today', () => {
    const db = mockDb({
        tables: {
            daily_direction: [{
                store_date: '2026-06-10',
                posted_at: '2026-06-10T08:00:00Z',
                posted_by: 'Alex',
                floor_message: 'TODAY: YELLOW (Wednesday · TGP Order Day)\nMust-win:\n• Keep floor tight',
                floor_message_edited: 0,
                posted_snapshot_json: JSON.stringify({
                    status: 'yellow',
                    floor_message: 'TODAY: YELLOW (Wednesday · TGP Order Day)\nMust-win:\n• Keep floor tight',
                    day_context: { weekday: 'Wednesday', is_order_day: true, order_day_sources: ['order_clock'] },
                    must_wins: [{ text: 'Keep floor tight', owner: '' }],
                }),
            }],
        },
    });

    const draft = buildDailyDirectionDraft(db, {
        storeDate: '2026-06-10',
        clock: { storeWeekday: 'Wednesday' },
        kpis: { shift_active: true },
        settings: { Order_Start: '2026-06-10T09:00:00Z', Order_End: '' },
    });
    const row = db.get('SELECT * FROM daily_direction WHERE store_date = ?', '2026-06-10');
    const snap = JSON.parse(row.posted_snapshot_json);

    assert.equal(draft.day_context.is_order_day, false);
    assert.match(draft.floor_message, /Non-TGP Day/);
    assert.doesNotMatch(draft.floor_message, /TGP Order Day/);
    assert.equal(row.floor_message.includes('Non-TGP Day'), true);
    assert.equal(snap.day_context.is_order_day, false);
});

test('buildDailyDirectionDraft scrubs posted TGP label when only a stale clock exists', () => {
    const db = mockDb({
        tables: {
            daily_direction: [{
                store_date: '2026-06-10',
                posted_at: '2026-06-10T08:00:00Z',
                posted_by: 'Alex',
                floor_message: 'TODAY: YELLOW (Wednesday · TGP Order Day)\nMust-win:\n• Keep floor tight',
                floor_message_edited: 0,
                posted_snapshot_json: JSON.stringify({
                    status: 'yellow',
                    floor_message: 'TODAY: YELLOW (Wednesday · TGP Order Day)\nMust-win:\n• Keep floor tight',
                    day_context: { weekday: 'Wednesday', is_order_day: true, order_day_sources: ['order_clock'] },
                    must_wins: [{ text: 'Keep floor tight', owner: '' }],
                }),
            }],
        },
    });

    const draft = buildDailyDirectionDraft(db, {
        storeDate: '2026-06-10',
        clock: { storeWeekday: 'Wednesday' },
        kpis: { shift_active: false },
        settings: { Order_Start: '2026-06-09T09:00:00Z', Order_End: '' },
    });
    const row = db.get('SELECT * FROM daily_direction WHERE store_date = ?', '2026-06-10');
    const snap = JSON.parse(row.posted_snapshot_json);

    assert.equal(draft.day_context.is_order_day, false);
    assert.match(draft.floor_message, /Non-TGP Day/);
    assert.doesNotMatch(draft.floor_message, /TGP Order Day/);
    assert.equal(snap.day_context.is_order_day, false);
});

test('loadDailyDirectionReportView also scrubs stale posted TGP label for today', () => {
    const db = mockDb({
        tables: {
            daily_direction: [{
                store_date: '2026-06-10',
                posted_at: '2026-06-10T08:00:00Z',
                posted_by: 'Alex',
                floor_message: 'TODAY: YELLOW (Wednesday · TGP Order Day)\nMust-win:\n• Keep floor tight',
                floor_message_edited: 1,
                posted_snapshot_json: JSON.stringify({
                    status: 'yellow',
                    floor_message: 'TODAY: YELLOW (Wednesday · TGP Order Day)\nMust-win:\n• Keep floor tight',
                    day_context: { weekday: 'Wednesday', is_order_day: true, order_day_sources: ['order_clock'] },
                    must_wins: [{ text: 'Keep floor tight', owner: '' }],
                }),
            }],
        },
    });

    const view = loadDailyDirectionReportView(db, '2026-06-10');

    assert.equal(view.day_context.is_order_day, false);
    assert.match(view.floor_message, /Non-TGP Day/);
    assert.doesNotMatch(view.floor_message, /TGP Order Day/);
});


test('loadDailyDirectionReportView exposes posted Daily Direction and Shift Updates for historical reports', () => {
    const db = mockDb({
        tables: {
            daily_direction: [{
                store_date: '2026-06-07',
                posted_at: '2026-06-07T08:00:00Z',
                posted_by: 'Alex',
                posted_msg_id: 'msg-1',
                posted_snapshot_json: JSON.stringify({
                    status: 'green',
                    floor_message: 'SHIFT UPDATE — receiving is caught up.',
                    must_wins: [{ text: 'Face Zone 1', owner: 'Sam' }],
                    last_updated_at: '2026-06-07T12:15:00Z',
                    last_updated_by: 'Alex',
                    update_sequence: 1,
                    day_context: { weekday: 'Sunday', is_order_day: true },
                    walk_notes: { free_text: 'Front end clean', flags: {} },
                    manager_only_notes: 'Watch receiving.',
                }),
                must_wins_json: '[]',
                walk_notes_json: '{}',
                manager_only_notes: '',
            }],
            shift_updates: [{
                store_date: '2026-06-07',
                sequence_num: 1,
                message: 'SHIFT UPDATE — receiving is caught up.',
                triggers_json: '[]',
                posted_at: '2026-06-07T12:15:00Z',
                posted_by: 'Alex',
                posted_msg_id: 'msg-2',
                snapshot_json: '{}',
            }],
        },
    });

    const view = loadDailyDirectionReportView(db, '2026-06-07');
    assert.equal(view.archived, true);
    assert.equal(view.status, 'green');
    assert.equal(view.floor_message, 'SHIFT UPDATE — receiving is caught up.');
    assert.equal(view.must_wins[0].text, 'Face Zone 1');
    assert.equal(view.posted.posted_by, 'Alex');
    assert.equal(view.shift_updates.length, 1);
    assert.equal(view.shift_updates[0].message, 'SHIFT UPDATE — receiving is caught up.');
    assert.equal(view.can_edit, false);
});



test('saveDailyDirectionEdits normalizes edited floor-message status to saved override', () => {
    const db = mockDb();
    saveDailyDirectionEdits(db, '2026-06-24', {
        status_override: 'yellow',
        floor_message: 'TODAY: RED (WEDNESDAY)\nFocus: test',
    }, 'Manager');
    assert.equal(db.all('SELECT * FROM daily_direction', '2026-06-24').length, 0);
    const row = db.get('SELECT * FROM daily_direction WHERE store_date = ?', '2026-06-24');
    assert.equal(row.status_override, 'yellow');
    assert.match(row.floor_message, /^TODAY: YELLOW/);
});

test('repairPostedDailyDirectionOrderDay preserves manager-edited floor message', () => {
    const originalMessage = 'TODAY: YELLOW (Wednesday · TGP Order Day)\nCustom manager text';
    const row = {
        store_date: '2026-06-10',
        posted_at: '2026-06-10T08:00:00Z',
        posted_by: 'Alex',
        floor_message: originalMessage,
        floor_message_edited: 1,
        posted_snapshot_json: JSON.stringify({
            status: 'yellow',
            floor_message: originalMessage,
            day_context: { weekday: 'Wednesday', is_order_day: true },
        }),
    };
    const db = mockDb({ tables: { daily_direction: [row] } });
    repairPostedDailyDirectionOrderDay(db, '2026-06-10', row, 'system', {
        storeWeekday: 'Wednesday',
        kpis: {},
        settings: {},
        orderDayBriefing: null,
    });
    assert.equal(row.floor_message, originalMessage);
});

test('syncMustWinsWithOpenBoard drops closed task wins and refills from open Urgent/High', () => {
    const db = mockDb({
        tables: {
            tasks: [
                {
                    task_id: 'T-OPEN-1',
                    status: 'Open',
                    priority: 'Urgent',
                    zone: 'Zone 2',
                    task_detail: 'Build endcap',
                    assigned_to: 'Sam',
                    time_submitted: '2026-06-07T09:00:00Z',
                },
                {
                    task_id: 'T-OPEN-2',
                    status: 'Open',
                    priority: 'High',
                    zone: 'Zone 3',
                    task_detail: 'Face dairy',
                    assigned_to: 'Unassigned',
                    time_submitted: '2026-06-07T09:30:00Z',
                },
            ],
            daily_direction: [{
                store_date: '2026-06-07',
                posted_at: '2026-06-07T08:00:00Z',
                posted_by: 'Alex',
                floor_message: 'TODAY: YELLOW\nMust-win:\n• Old closed work\n• Keep floor tight',
                must_wins_json: '[]',
                posted_snapshot_json: JSON.stringify({
                    status: 'yellow',
                    floor_message: 'TODAY: YELLOW\nMust-win:\n• Old closed work\n• Keep floor tight',
                    must_wins: [
                        {
                            text: 'Old closed work',
                            owner: '',
                            task_id: 'T-CLOSED',
                            source_risk_id: 'task:Zone 1: Old closed work',
                        },
                        { text: 'Keep floor tight', owner: '' },
                    ],
                }),
            }],
        },
    });

    const synced = syncMustWinsWithOpenBoard(db, '2026-06-07', { settings: {} });
    assert.equal(synced.changed, true);
    assert.equal(synced.must_wins.length, 3);
    assert.ok(synced.must_wins.some((w) => w.task_id === 'T-OPEN-1'));
    assert.ok(synced.must_wins.some((w) => w.task_id === 'T-OPEN-2'));
    assert.ok(synced.must_wins.some((w) => w.text === 'Keep floor tight'));
    assert.ok(!synced.must_wins.some((w) => w.task_id === 'T-CLOSED'));

    const floor = loadDailyDirectionFloor(db, '2026-06-07');
    assert.equal(floor.must_wins.length, 3);
    assert.ok(floor.must_wins.every((w) => w.task_id !== 'T-CLOSED'));
});
