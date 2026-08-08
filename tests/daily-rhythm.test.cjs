'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeDailyRhythm, ensureDailyRhythmOnBoot, countOpenTasks } = require('../src/lib/daily-rhythm.cjs');

function mockDb(initial = {}) {
    const settings = new Map(Object.entries(initial.settings || {}));
    const tasks = [...(initial.tasks || [])];
    const rhythmTasks = [...(initial.rhythm_tasks || [
        { detail: 'Store walk', priority: 'Routine', zone: 'General', est_mins: 15 },
        { detail: 'FIFO Audit', priority: 'Routine', zone: 'General', est_mins: 15 },
    ])];
    const vendors = [...(initial.vendors || [])];

    function taskStoreDate(task) {
        return String(task.time_submitted || '').slice(0, 10);
    }

    return {
        get(sql, ...params) {
            if (sql.includes('setting_name=?') && params[0]) {
                return { setting_value: settings.get(params[0]) || '' };
            }
            if (sql.includes('Daily_Rhythm_Last_Loaded')) {
                return { setting_value: settings.get('Daily_Rhythm_Last_Loaded') || '' };
            }
            if (sql.includes('Rhythm_Deferred')) {
                return { setting_value: settings.get('Rhythm_Deferred') || '' };
            }
            if (sql.includes('Daily direction huddle')) {
                return tasks.find((t) => t.status === 'Open'
                    && String(t.task_detail || '').includes('Daily direction huddle')) || undefined;
            }
            if (sql.includes("status='Open'") && sql.includes('date(time_submitted')) {
                const day = params[1];
                return {
                    c: tasks.filter((t) => t.status === 'Open'
                        && taskStoreDate(t) === day
                        && !String(t.task_id || '').startsWith('AUTO-PULL-')).length,
                };
            }
            if (sql.includes("status='Open'")) {
                return { c: tasks.filter((t) => t.status === 'Open').length };
            }
            if (sql.includes('date(time_submitted')) {
                const day = params[1];
                return {
                    c: tasks.filter((t) => taskStoreDate(t) === day
                        && !String(t.task_id || '').startsWith('AUTO-PULL-')).length,
                };
            }
            return undefined;
        },
        all(sql, ...params) {
            if (sql.includes('rhythm_tasks')) {
                const day = params[0];
                return rhythmTasks.filter((t) => t.day === day || t.day === 'Everyday' || !t.day);
            }
            if (sql.includes('vendor_schedule')) return vendors.filter((v) => v.day === params[0]);
            if (sql.includes('SELECT task_detail FROM tasks') && sql.includes("status='Open'")) {
                const day = params[1];
                return tasks
                    .filter((t) => t.status === 'Open' && taskStoreDate(t) === day)
                    .map((t) => ({ task_detail: t.task_detail }));
            }
            if (sql.includes('SELECT task_detail FROM tasks') && sql.includes('date(time_submitted')) {
                const day = params[1];
                return tasks
                    .filter((t) => taskStoreDate(t) === day
                        && !String(t.task_id || '').startsWith('AUTO-PULL-'))
                    .map((t) => ({ task_detail: t.task_detail }));
            }
            return [];
        },
        run(sql, ...params) {
            if (sql.includes('Daily_Rhythm_Last_Loaded') && sql.includes('INSERT OR REPLACE')) {
                settings.set('Daily_Rhythm_Last_Loaded', params[0]);
            }
            if (sql.includes("setting_value=''") && sql.includes('Daily_Rhythm_Last_Loaded')) {
                settings.delete('Daily_Rhythm_Last_Loaded');
            }
            if (sql.includes('Rhythm_Deferred') && sql.includes('INSERT OR REPLACE')) {
                settings.set('Rhythm_Deferred', params[1] != null ? params[1] : params[0]);
            }
            if (sql.includes('INSERT INTO tasks')) {
                tasks.push({
                    task_id: params[0],
                    task_detail: params[1],
                    status: 'Open',
                    priority: params[2],
                    zone: params[3],
                    assigned_to: params[4],
                    est_mins: params[5],
                    time_submitted: params[6],
                });
            }
        },
        transaction(fn) {
            return () => fn();
        },
        exec() {},
        getSettings: () => initial.settingsObj || {},
        _tasks: tasks,
        _settings: settings,
    };
}

const deps = {
    getStoreDateStamp: () => '2026-05-31',
    getStoreDayName: () => 'Saturday',
    getTimezone: () => 'America/Edmonton',
    broadcastUpdate: () => {},
};

test('executeDailyRhythm tops up when open tasks exist without stamp (does not skip seed)', () => {
    const db = mockDb({
        settings: {},
        tasks: [
            { status: 'Open', task_detail: 'AUTO leftover', time_submitted: '2026-05-31T14:00:00.000Z' },
            { status: 'Open', task_detail: 'Store walk', time_submitted: '2026-05-31T14:00:00.000Z' },
        ],
    });
    const before = countOpenTasks(db);
    const res = executeDailyRhythm(db, deps, { reason: 'test-stamp-unset-topup' });
    assert.equal(res.success, true);
    assert.equal(res.toppedUp, true);
    assert.ok(countOpenTasks(db) >= before);
    assert.equal(db._settings.get('Daily_Rhythm_Last_Loaded'), '2026-05-31');
    assert.ok(db._tasks.some((t) => t.task_detail === 'FIFO Audit'));
});

test('executeDailyRhythm loads tasks and sets stamp', () => {
    const db = mockDb();
    const res = executeDailyRhythm(db, deps, { reason: 'test' });
    assert.equal(res.success, true);
    assert.ok(res.tasks >= 2);
    assert.equal(db._settings.get('Daily_Rhythm_Last_Loaded'), '2026-05-31');
    assert.ok(countOpenTasks(db) >= 2);
});

test('executeDailyRhythm returns alreadyLoaded when stamp matches and today has open tasks', () => {
    const db = mockDb({
        settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' },
        tasks: [
            { status: 'Open', task_detail: 'Store walk', time_submitted: '2026-05-31T14:00:00.000Z' },
            { status: 'Open', task_detail: 'FIFO Audit', time_submitted: '2026-05-31T14:00:00.000Z' },
        ],
    });
    const res = executeDailyRhythm(db, deps, { reason: 'test' });
    assert.equal(res.alreadyLoaded, true);
    assert.equal(res.openTasks, 2);
});

test('force reload when stamp set but board empty', () => {
    const db = mockDb({ settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' }, tasks: [] });
    const res = executeDailyRhythm(db, deps, { force: true, reason: 'test-force' });
    assert.equal(res.success, true);
    assert.equal(res.forced, true);
    assert.ok(countOpenTasks(db) >= 2);
});

test('force top-up adds missing rhythm when today already has open tasks', () => {
    const db = mockDb({
        settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' },
        tasks: [
            { status: 'Open', task_detail: 'Store walk', time_submitted: '2026-05-31T14:00:00.000Z' },
        ],
        rhythm_tasks: [
            { detail: 'Store walk', priority: 'Routine', zone: 'General', est_mins: 15 },
            { detail: 'FIFO Audit', priority: 'Routine', zone: 'General', est_mins: 15 },
        ],
    });
    const before = countOpenTasks(db);
    const res = executeDailyRhythm(db, deps, { force: true, reason: 'test-force-topup' });
    assert.equal(res.success, true);
    assert.equal(res.forced, true);
    assert.equal(res.toppedUp, true);
    assert.ok(res.tasks >= 1);
    assert.ok(countOpenTasks(db) > before);
    assert.ok(db._tasks.some((t) => t.task_detail === 'FIFO Audit'));
    assert.equal(db._tasks.filter((t) => t.task_detail === 'Store walk').length, 1);
});

test('seeds routine rhythm when stamp set but only yesterday carryover remains', () => {
    const db = mockDb({
        settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' },
        tasks: [
            { status: 'Open', priority: 'Urgent', time_submitted: '2026-05-30T20:00:00.000Z' },
            { status: 'Open', priority: 'High', time_submitted: '2026-05-30T21:00:00.000Z' },
        ],
    });
    const before = countOpenTasks(db);
    const res = executeDailyRhythm(db, deps, { reason: 'test-carryover' });
    assert.equal(res.success, true);
    assert.equal(res.seededWithCarryover, true);
    assert.ok(countOpenTasks(db) > before);
});

test('alreadyLoaded when stamp set and tasks were already submitted today (even if closed)', () => {
    const db = mockDb({
        settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' },
        tasks: [
            { status: 'Closed', time_submitted: '2026-05-31T10:00:00.000Z' },
            { status: 'Open', priority: 'Urgent', time_submitted: '2026-05-30T20:00:00.000Z' },
        ],
    });
    const before = countOpenTasks(db);
    const res = executeDailyRhythm(db, deps, { reason: 'test-done-today' });
    assert.equal(res.alreadyLoaded, true);
    assert.equal(countOpenTasks(db), before);
});

test('ensureDailyRhythmOnBoot auto force when empty board', () => {
    const db = mockDb({ settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' }, tasks: [] });
    const calls = [];
    const res = ensureDailyRhythmOnBoot(db, deps, (opts) => {
        calls.push(opts);
        return executeDailyRhythm(db, deps, opts);
    });
    assert.equal(calls[0].force, true);
    assert.equal(calls[0].reason, 'boot-recover');
    assert.equal(res.success, true);
});

test('ensureDailyRhythmOnBoot auto force when only carryover open', () => {
    const db = mockDb({
        settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' },
        tasks: [{ status: 'Open', time_submitted: '2026-05-30T18:00:00.000Z' }],
    });
    const calls = [];
    const res = ensureDailyRhythmOnBoot(db, deps, (opts) => {
        calls.push(opts);
        return executeDailyRhythm(db, deps, opts);
    });
    assert.equal(calls[0].force, true);
    assert.equal(calls[0].reason, 'boot-recover-carryover');
    assert.equal(res.success, true);
});

test('ensureDailyRhythmOnBoot skips force reload when tasks already ran today', () => {
    const db = mockDb({
        settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' },
        tasks: [{ status: 'Closed', time_submitted: '2026-05-31T15:00:00.000Z' }],
    });
    const calls = [];
    const res = ensureDailyRhythmOnBoot(db, deps, (opts) => {
        calls.push(opts);
        return executeDailyRhythm(db, deps, opts);
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].force, undefined);
    assert.equal(calls[0].reason, 'boot');
    assert.equal(res.alreadyLoaded, true);
});

test('ensureDailyRhythmOnBoot normal boot when not loaded', () => {
    const db = mockDb();
    const calls = [];
    ensureDailyRhythmOnBoot(db, deps, (opts) => {
        calls.push(opts);
        return executeDailyRhythm(db, deps, opts);
    });
    assert.equal(calls[0].force, undefined);
    assert.equal(calls[0].reason, 'boot');
});

test('AUTO-PULL opens alone do not count as alreadyLoaded for today', () => {
    const db = mockDb({
        settings: { Daily_Rhythm_Last_Loaded: '' },
        tasks: [{
            task_id: 'AUTO-PULL-1',
            status: 'Open',
            time_submitted: '2026-05-31T08:00:00.000Z',
            task_detail: 'Pull expired',
        }],
    });
    const res = executeDailyRhythm(db, deps, { reason: 'scheduled' });
    assert.equal(res.alreadyLoaded, undefined);
    assert.equal(res.success, true);
    assert.ok((res.tasks || 0) >= 1);
});

test('maybeEnsureMorningRhythm skips outside morning window', () => {
    const { maybeEnsureMorningRhythm, buildMorningRhythmStatus } = require('../src/lib/daily-rhythm.cjs');
    const db = mockDb();
    const calls = [];
    const res = maybeEnsureMorningRhythm(
        db,
        { ...deps, storeTime: '05:59' },
        (opts) => { calls.push(opts); return { success: true }; },
        { reason: 'test' },
    );
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'outside_window');
    assert.equal(calls.length, 0);
    const status = buildMorningRhythmStatus(db, { ...deps, storeTime: '06:45' });
    assert.equal(status.needs_attention, true);
});

test('maybeEnsureMorningRhythm heals when stamp unset after 06:00', () => {
    const { maybeEnsureMorningRhythm } = require('../src/lib/daily-rhythm.cjs');
    const db = mockDb({ settings: { Daily_Rhythm_Last_Loaded: '' } });
    const calls = [];
    const res = maybeEnsureMorningRhythm(
        db,
        { ...deps, storeTime: '07:10' },
        (opts) => {
            calls.push(opts);
            return executeDailyRhythm(db, deps, opts);
        },
        { reason: 'test-heal', force: true },
    );
    assert.equal(calls.length >= 1, true);
    assert.equal(res.success, true);
    assert.equal(res.status.loaded, true);
});

test('buildMorningRhythmStatus flags incomplete when templates missing', () => {
    const { buildMorningRhythmStatus } = require('../src/lib/daily-rhythm.cjs');
    const db = mockDb({
        settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' },
        tasks: [
            { status: 'Open', task_detail: 'Store walk', time_submitted: '2026-05-31T14:00:00.000Z' },
        ],
        rhythm_tasks: [
            { id: 1, detail: 'Store walk', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
            { id: 2, detail: 'FIFO Audit', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
        ],
    });
    const status = buildMorningRhythmStatus(db, { ...deps, storeTime: '07:00' });
    assert.equal(status.loaded, true);
    assert.equal(status.incomplete, true);
    assert.equal(status.missing_rhythm_count, 1);
    assert.equal(status.needs_attention, true);
});

test('buildMorningRhythmStatus treats expanded FIFO as complete', () => {
    const { buildMorningRhythmStatus } = require('../src/lib/daily-rhythm.cjs');
    const db = mockDb({
        settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' },
        tasks: [
            { status: 'Open', task_detail: 'Store walk', time_submitted: '2026-05-31T14:00:00.000Z' },
            { status: 'Open', task_detail: 'FIFO Audit — A1, A2', time_submitted: '2026-05-31T14:00:00.000Z' },
        ],
        rhythm_tasks: [
            { id: 1, detail: 'Store walk', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
            { id: 2, detail: 'FIFO Audit', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
        ],
    });
    const status = buildMorningRhythmStatus(db, { ...deps, storeTime: '07:00' });
    assert.equal(status.loaded, true);
    assert.equal(status.incomplete, false);
    assert.equal(status.missing_rhythm_count, 0);
    assert.equal(status.needs_attention, false);
});

test('openDetailCoversTemplate matches exact and em-dash expands', () => {
    const { openDetailCoversTemplate } = require('../src/lib/daily-rhythm.cjs');
    const open = new Set(['FIFO Audit — A1', 'Store walk']);
    assert.equal(openDetailCoversTemplate('FIFO Audit', open), true);
    assert.equal(openDetailCoversTemplate('Store walk', open), true);
    assert.equal(openDetailCoversTemplate('Pull expired', open), false);
});

test('listMissingRhythmDetails marks FIFO incomplete when only some aisles boarded', () => {
    const { listMissingRhythmDetails } = require('../src/lib/daily-rhythm.cjs');
    const sched = require('../src/lib/rhythm-schedule-assign.cjs');
    const orig = {
        expand: sched.expandRhythmTaskForBoard,
        build: sched.buildRhythmAssignContext,
        skip: sched.shouldSkipFifoRhythm,
    };
    sched.shouldSkipFifoRhythm = () => false;
    sched.buildRhythmAssignContext = () => ({ hasSchedule: true, storeDate: '2026-05-31' });
    sched.expandRhythmTaskForBoard = () => ([
        { task_detail: 'FIFO Audit — A1' },
        { task_detail: 'FIFO Audit — A2' },
    ]);
    try {
        const db = mockDb({
            tasks: [
                { status: 'Open', task_detail: 'FIFO Audit — A1', time_submitted: '2026-05-31T14:00:00.000Z' },
            ],
            rhythm_tasks: [
                { id: 2, detail: 'FIFO Audit', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
            ],
        });
        const report = listMissingRhythmDetails(db, deps);
        assert.deepEqual(report.missing, ['FIFO Audit']);
        assert.equal(report.deferralLookupFailed, false);
    } finally {
        sched.expandRhythmTaskForBoard = orig.expand;
        sched.buildRhythmAssignContext = orig.build;
        sched.shouldSkipFifoRhythm = orig.skip;
    }
});

test('listMissingRhythmDetails fail-closes FIFO when expand throws', () => {
    const { listMissingRhythmDetails } = require('../src/lib/daily-rhythm.cjs');
    const sched = require('../src/lib/rhythm-schedule-assign.cjs');
    const orig = {
        expand: sched.expandRhythmTaskForBoard,
        build: sched.buildRhythmAssignContext,
        skip: sched.shouldSkipFifoRhythm,
    };
    sched.shouldSkipFifoRhythm = () => false;
    sched.buildRhythmAssignContext = () => ({ hasSchedule: true });
    sched.expandRhythmTaskForBoard = () => { throw new Error('expand boom'); };
    try {
        const db = mockDb({
            tasks: [
                { status: 'Open', task_detail: 'FIFO Audit — A1', time_submitted: '2026-05-31T14:00:00.000Z' },
            ],
            rhythm_tasks: [
                { id: 2, detail: 'FIFO Audit', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
            ],
        });
        const report = listMissingRhythmDetails(db, deps);
        assert.deepEqual(report.missing, ['FIFO Audit']);
    } finally {
        sched.expandRhythmTaskForBoard = orig.expand;
        sched.buildRhythmAssignContext = orig.build;
        sched.shouldSkipFifoRhythm = orig.skip;
    }
});

test('rhythm inserts land on store calendar day (store-local ISO)', () => {
    const db = mockDb();
    const { rhythmSubmittedAtIso } = require('../src/lib/store-time.cjs');
    const iso = rhythmSubmittedAtIso({ getTimezone: () => 'America/Edmonton', storeTime: '12:00 PM' }, '2026-05-31');
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(iso));
    const vals = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    assert.equal(`${vals.year}-${vals.month}-${vals.day}`, '2026-05-31');

    const res = executeDailyRhythm(db, { ...deps, storeTime: '12:00 PM' }, { reason: 'test-stamp-iso' });
    assert.equal(res.success, true);
    assert.ok(res.openToday >= 2);
});

test('executeDailyRhythm aborts when deferral lookup throws', () => {
    const db = mockDb();
    const reports = require('../src/lib/reports-actions.cjs');
    const orig = reports.getDeferredRhythmIds;
    reports.getDeferredRhythmIds = () => { throw new Error('defer boom'); };
    try {
        const res = executeDailyRhythm(db, deps, { reason: 'test-defer-abort' });
        assert.equal(res.deferral_lookup_failed, true);
        assert.ok(res.error);
        assert.equal(db._tasks.length, 0);
    } finally {
        reports.getDeferredRhythmIds = orig;
    }
});

test('rhythmSubmittedAtIso respects store clock time', () => {
    const { rhythmSubmittedAtIso } = require('../src/lib/store-time.cjs');
    const iso = rhythmSubmittedAtIso({
        getTimezone: () => 'America/Edmonton',
        storeTime: '7:15 AM',
    }, '2026-05-31');
    const hour = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Edmonton', hour: 'numeric', hour12: false,
    }).format(new Date(iso));
    const minute = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Edmonton', minute: '2-digit',
    }).format(new Date(iso));
    assert.equal(Number(hour), 7);
    assert.equal(Number(minute), 15);
});

test('maybeEnsureMorningRhythm does not false-skip partial board', () => {
    const { maybeEnsureMorningRhythm } = require('../src/lib/daily-rhythm.cjs');
    const db = mockDb({
        settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' },
        tasks: [
            { status: 'Open', task_detail: 'Store walk', time_submitted: '2026-05-31T14:00:00.000Z' },
        ],
        rhythm_tasks: [
            { id: 1, detail: 'Store walk', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
            { id: 2, detail: 'FIFO Audit', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
        ],
    });
    const calls = [];
    const res = maybeEnsureMorningRhythm(
        db,
        { ...deps, storeTime: '07:15' },
        (opts) => {
            calls.push(opts);
            return executeDailyRhythm(db, deps, opts);
        },
        { reason: 'test-partial', force: true },
    );
    assert.equal(res.skipped, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].force, true);
    assert.ok(String(calls[0].reason || '').includes('top-up'));
    // Mock inserts use wall-clock ISO dates; store stamp is fixed — assert board top-up, not healed flag.
    assert.ok(db._tasks.some((t) => t.task_detail === 'FIFO Audit'));
});

test('maybeEnsureMorningRhythm skips when board is complete', () => {
    const { maybeEnsureMorningRhythm } = require('../src/lib/daily-rhythm.cjs');
    const db = mockDb({
        settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' },
        tasks: [
            { status: 'Open', task_detail: 'Store walk', time_submitted: '2026-05-31T14:00:00.000Z' },
            { status: 'Open', task_detail: 'FIFO Audit', time_submitted: '2026-05-31T14:00:00.000Z' },
        ],
        rhythm_tasks: [
            { id: 1, detail: 'Store walk', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
            { id: 2, detail: 'FIFO Audit', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
        ],
    });
    const calls = [];
    const res = maybeEnsureMorningRhythm(
        db,
        { ...deps, storeTime: '07:15' },
        (opts) => { calls.push(opts); return { success: true }; },
        { reason: 'test-healthy', force: true },
    );
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'already_healthy');
    assert.equal(calls.length, 0);
});

test('closed same-day details cover templates (no incomplete after finish)', () => {
    const { buildMorningRhythmStatus } = require('../src/lib/daily-rhythm.cjs');
    const db = mockDb({
        settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' },
        tasks: [
            { status: 'Closed', task_detail: 'Store walk', time_submitted: '2026-05-31T14:00:00.000Z' },
            { status: 'Closed', task_detail: 'FIFO Audit — A1', time_submitted: '2026-05-31T14:00:00.000Z' },
        ],
        rhythm_tasks: [
            { id: 1, detail: 'Store walk', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
            { id: 2, detail: 'FIFO Audit', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
        ],
    });
    const status = buildMorningRhythmStatus(db, { ...deps, storeTime: '07:45' });
    assert.equal(status.loaded, true);
    assert.equal(status.open_today, 0);
    assert.equal(status.incomplete, false);
    assert.equal(status.needs_attention, false);
});

test('maybeEnsureMorningRhythm does not reseed a finished board', () => {
    const { maybeEnsureMorningRhythm } = require('../src/lib/daily-rhythm.cjs');
    const db = mockDb({
        settings: { Daily_Rhythm_Last_Loaded: '2026-05-31' },
        tasks: [
            { status: 'Closed', task_detail: 'Store walk', time_submitted: '2026-05-31T14:00:00.000Z' },
            { status: 'Closed', task_detail: 'FIFO Audit', time_submitted: '2026-05-31T14:00:00.000Z' },
        ],
        rhythm_tasks: [
            { id: 1, detail: 'Store walk', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
            { id: 2, detail: 'FIFO Audit', day: 'Everyday', priority: 'Routine', zone: 'General', est_mins: 15 },
        ],
    });
    const calls = [];
    const res = maybeEnsureMorningRhythm(
        db,
        { ...deps, storeTime: '08:00' },
        (opts) => { calls.push(opts); return { success: true }; },
        { reason: 'test-finished', force: true },
    );
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'already_healthy');
    assert.equal(calls.length, 0);
    assert.equal(db._tasks.filter((t) => t.status === 'Open').length, 0);
});

test('corrupt Rhythm_Deferred JSON aborts seed', () => {
    const db = mockDb({
        settings: { Rhythm_Deferred: '{not-json' },
    });
    const res = executeDailyRhythm(db, deps, { reason: 'test-corrupt-defer' });
    assert.equal(res.deferral_lookup_failed, true);
    assert.ok(res.error);
    assert.equal(db._tasks.length, 0);
});
