'use strict';

/**
 * Regression + edge-case tests for daily rhythm / EOD duplication fixes
 * and schedule-based assignment guards.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    executeDailyRhythm,
    countOpenTasks,
} = require('../src/lib/daily-rhythm.cjs');
const {
    buildRhythmAssignContext,
    expandRhythmTaskForBoard,
    resolveAssignee,
} = require('../src/lib/rhythm-schedule-assign.cjs');

const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.cjs'), 'utf8');

test('EOD only clears Daily_Rhythm_Last_Loaded on new store day', () => {
    assert.match(apiSrc, /isNewStoreDay/);
    assert.match(apiSrc, /Daily_Rhythm_Last_Loaded/);
    assert.match(apiSrc, /if \(isNewStoreDay\)/);
    assert.doesNotMatch(
        apiSrc,
        /UPDATE settings SET setting_value='' WHERE setting_name IN \('Order_Start','Order_End','Daily_Rhythm_Last_Loaded','Active_Manager'\)/,
    );
});

test('EOD resets Hardware_Arrived and stamps unfinished clock end', () => {
    assert.match(apiSrc, /Hardware_Arrived/);
    assert.match(apiSrc, /orderEnd = oe \|\| t_now/);
    assert.match(apiSrc, /UPDATE counts SET hardware=0 WHERE id=1/);
});

test('EOD aborts archive when daily snapshot fails', () => {
    assert.match(apiSrc, /Eod_Last_Snapshot_Error/);
    assert.match(apiSrc, /EOD aborted: daily report snapshot failed/);
    assert.match(apiSrc, /if \(!skipOrderHistoryArchive\)/);
});

test('EOD archives tasks by store calendar date not host local midnight', () => {
    assert.match(apiSrc, /sqliteTzOffsetModifier/);
    assert.match(apiSrc, /date\(time_submitted, \?\) < date\(\?\)/);
    assert.match(apiSrc, /date\(time_logged, \?\) < date\(\?\)/);
    assert.doesNotMatch(apiSrc, /localMidnight/);
});

test('EOD stamps Last_EOD_Sweep even when the settings row is absent', () => {
    // Nothing seeds this row. With a plain UPDATE the stamp never landed on a fresh
    // install, and catchUpMissedSweeps then ran a destructive sweep on every boot.
    assert.match(
        apiSrc,
        /INSERT OR REPLACE INTO settings \(setting_name,setting_value\) VALUES \('Last_EOD_Sweep',\?\)/,
    );
    assert.doesNotMatch(apiSrc, /UPDATE settings SET setting_value=\?\s+WHERE setting_name='Last_EOD_Sweep'/);
});

test('EOD sweep refuses to run concurrently with itself', () => {
    // Scheduler, boot catch-up and the manual manager action can all fire it.
    assert.match(apiSrc, /let eodRunning = false/);
    assert.match(apiSrc, /if \(eodRunning\)/);
    assert.match(apiSrc, /finally \{\s*eodRunning = false;/);
});

test('EOD is a no-op when Last_EOD_Sweep is already today', () => {
    assert.match(apiSrc, /lastEod === today/);
    assert.match(apiSrc, /already_swept/);
});

test('EOD catch-up does not clear Order_Start when archive is skipped', () => {
    // Intermediate catch-up days skip archive — clearing the clock there wiped a live
    // floor clock across multi-day gaps with no history row.
    assert.match(apiSrc, /if \(!skipOrderHistoryArchive\) \{[\s\S]*Order_Start/);
    assert.match(apiSrc, /Leaving live order clock intact/);
});

test('rhythm tops up without duplicating when open tasks exist for store date without stamp', () => {
    // A missing stamp with tasks already on the board (typical after a midnight AUTO-PULL)
    // must still seed the rest of the day — but only details that are not already open.
    const settings = new Map();
    const openToday = ['Face dairy', 'Sweep aisles'];
    const inserted = [];
    const db = {
        get(sql) {
            if (sql.includes('Daily_Rhythm_Last_Loaded')) return { setting_value: '' };
            if (sql.includes("status='Open'") || sql.includes('date(time_submitted')) {
                return { c: openToday.length + inserted.length };
            }
            return undefined;
        },
        all(sql, ...params) {
            if (sql.includes('FROM tasks')) {
                return [...openToday, ...inserted].map((task_detail) => ({ task_detail }));
            }
            if (sql.includes('FROM rhythm_tasks')) {
                assert.equal(params[0], 'Wednesday');
                return [
                    { id: 'R-1', day: 'Wednesday', detail: 'Face dairy', task_detail: 'Face dairy', priority: 'Routine', zone: 'Dairy', est_mins: 20 },
                    { id: 'R-2', day: 'Wednesday', detail: 'Cull produce', task_detail: 'Cull produce', priority: 'Routine', zone: 'Produce', est_mins: 15 },
                ];
            }
            return [];
        },
        run(sql, ...params) {
            if (sql.includes('INSERT INTO tasks')) inserted.push(params[1]);
            if (sql.includes('Daily_Rhythm_Last_Loaded') && sql.includes('INSERT OR REPLACE')) {
                settings.set('Daily_Rhythm_Last_Loaded', params[0]);
            }
            return { changes: 1 };
        },
        transaction(fn) { return () => fn(); },
        exec() {},
    };
    const deps = {
        getStoreDateStamp: () => '2026-07-08',
        getStoreDayName: () => 'Wednesday',
        getTimezone: () => 'America/Edmonton',
        broadcastUpdate: () => {},
    };

    const res = executeDailyRhythm(db, deps, { reason: 'chaos-dup-guard' });

    assert.equal(res.success, true);
    assert.deepEqual(inserted, ['Cull produce'], 'already-open detail must not be re-inserted');
    assert.equal(res.skippedExisting, 1);
    assert.equal(settings.get('Daily_Rhythm_Last_Loaded'), '2026-07-08');
});

test('FIFO and bucket assignees skip staff not on today schedule', () => {
    const db = {
        get(sql, ...params) {
            if (sql.includes('setting_name')) {
                const name = params[0];
                if (name === 'FIFO_Aisle_Assignments') {
                    return {
                        setting_value: JSON.stringify([
                            { staff: 'Kevin', aisles: ['A1'] },
                            { staff: 'Abigail', aisles: ['A2'] },
                        ]),
                    };
                }
                if (name === 'Active_Manager') return { setting_value: 'Ghost Manager' };
                return undefined;
            }
            return undefined;
        },
        all(sql, ...params) {
            if (sql.includes('staff_shifts')) {
                return [{ staff_name: 'Kevin', shift_date: params[0], department: 'Stock/Float', role: '', start_time: '07:00' }];
            }
            if (sql.includes('FROM staff')) {
                return [
                    { name: 'Kevin', role: 'Clerk', shift_lead_eligible: 0 },
                    { name: 'Abigail', role: 'Clerk', shift_lead_eligible: 0 },
                    { name: 'Ghost Manager', role: 'Manager', shift_lead_eligible: 1 },
                ];
            }
            return [];
        },
    };
    const ctx = buildRhythmAssignContext(db, '2026-07-08');
    assert.equal(resolveAssignee(ctx, 'shift_lead', 'Store walk'), 'Unassigned');
    const fifo = expandRhythmTaskForBoard(db, { detail: 'FIFO Audit', zone: 'General' }, ctx);
    assert.equal(fifo.length, 1);
    assert.equal(fifo[0].assigned_to, 'Kevin');
    assert.ok(fifo.every((r) => r.assigned_to !== 'Abigail'));
});

test('rhythm module has in-process concurrency guard', () => {
    assert.match(
        fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'daily-rhythm.cjs'), 'utf8'),
        /let rhythmRunning = false/,
    );
    assert.match(
        fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'daily-rhythm.cjs'), 'utf8'),
        /rhythmRunning = true/,
    );
});
