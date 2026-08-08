'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    insertMessage,
    dismissMessage,
    promoteToPinned,
    buildCommsSyncPayload,
    filterMessagesForViewer,
    isMessageCenterEnabled,
    archiveCommsForEod,
    getHandoffForReportDate,
    syncSystemMessages,
} = require('../src/lib/comms-center.cjs');

function mockDb() {
    const messages = [];
    const handoffs = [];
    const settings = {
        Message_Center_Enabled: '1',
        Comms_System_Messages: '0',
        Order_Start: '',
        Order_End: '',
    };
    return {
        messages,
        handoffs,
        settings,
        get(sql, ...params) {
            if (sql.includes('comms_messages') && sql.includes('dedupe_key')) {
                const key = params[0];
                const active = messages.find((m) => m.dedupe_key === key && !m.dismissed_at && !m.archived_at);
                if (active) return active;
                // insertMessage now looks up dismissed-but-not-archived keys too
                return messages.find((m) => m.dedupe_key === key && !m.archived_at) || null;
            }
            if (sql.includes('comms_messages') && sql.includes('msg_id')) {
                return messages.find((m) => m.msg_id === params[0]) || null;
            }
            if (sql.includes('comms_handoff_archive') && sql.includes('store_date')) {
                return handoffs.find((h) => h.store_date === params[0]) || null;
            }
            if (sql.includes("setting_name='Daily_Rhythm_Last_Loaded'")) {
                return { setting_value: settings.Daily_Rhythm_Last_Loaded };
            }
            if (sql.includes('FROM settings')) {
                const name = params[0];
                return { setting_value: settings[name] };
            }
            if (sql.includes('COUNT(*)') && sql.includes('expected_orders')) return { c: 0 };
            if (sql.includes('COUNT(*)') && sql.includes('kill_dates')) return { c: 0 };
            if (sql.includes("FROM oos WHERE status='Open'")) return { c: 0 };
            if (sql.includes('rhythm_tasks')) return null;
            return null;
        },
        all(sql, ...params) {
            if (sql.includes('FROM comms_messages') && sql.includes("source = 'system'") && sql.includes('archived_at IS NULL')) {
                return messages.filter((m) => m.source === 'system' && !m.archived_at);
            }
            if (sql.includes('FROM comms_messages')) {
                return messages.filter((m) => !m.dismissed_at && !m.archived_at);
            }
            if (sql.includes('FROM expected_orders')) return [];
            return [];
        },
        run(sql, ...params) {
            if (sql.includes('UPDATE comms_messages') && sql.includes('SET dismissed_at = ?') && sql.includes("lane = 'pinned'") && !sql.includes('msg_id')) {
                messages.forEach((m) => {
                    if (m.lane === 'pinned' && m.source === 'human' && !m.dismissed_at && !m.archived_at) {
                        m.dismissed_at = params[0];
                        m.dismissed_by = params[1];
                    }
                });
                return;
            }
            if (sql.startsWith('INSERT INTO comms_messages')) {
                messages.push({
                    msg_id: params[0],
                    lane: params[1],
                    body: params[2],
                    priority: params[3],
                    source: params[4],
                    posted_by: params[5],
                    posted_at: params[6],
                    expires_at: params[7],
                    zone: params[8],
                    dedupe_key: params[9],
                    meta_json: params[10],
                });
                return;
            }
            if (sql.startsWith('UPDATE comms_messages') && sql.includes('SET body = ?')) {
                const msg = messages.find((m) => m.msg_id === params[5]);
                if (msg) {
                    msg.body = params[0];
                    msg.priority = params[1];
                    msg.posted_at = params[2];
                    msg.expires_at = params[3];
                    msg.meta_json = params[4];
                }
                return;
            }
            if (sql.startsWith('UPDATE comms_messages') && sql.includes("lane = 'pinned'") && sql.includes('source =')) {
                const msg = messages.find((m) => m.msg_id === params[3]);
                if (msg) {
                    msg.lane = 'pinned';
                    msg.priority = params[0];
                    msg.posted_at = params[1];
                    msg.posted_by = params[2];
                    msg.source = 'human';
                }
                return;
            }
            if (sql.startsWith('UPDATE comms_messages') && sql.includes('dismissed_at') && sql.includes("lane = 'pinned'")) {
                messages.forEach((m) => {
                    if (m.lane === 'pinned' && m.source === 'human' && !m.dismissed_at && !m.archived_at) {
                        m.dismissed_at = params[0];
                        m.dismissed_by = params[1];
                    }
                });
                return;
            }
            if (sql.startsWith('UPDATE comms_messages') && sql.includes('SET archived_at = ?') && sql.includes('msg_id') && !sql.includes('dismissed_at IS NULL')) {
                const msg = messages.find((m) => m.msg_id === params[1]);
                if (msg) msg.archived_at = params[0];
                return;
            }
            if (sql.startsWith('UPDATE comms_messages') && sql.includes('dismissed_at') && sql.includes('msg_id')) {
                const msg = messages.find((m) => m.msg_id === params[params.length - 1]);
                if (msg) {
                    msg.dismissed_at = params[0];
                    msg.dismissed_by = params[1];
                }
                return;
            }
            if (sql.includes('INSERT INTO comms_handoff_archive')) {
                handoffs.push({
                    store_date: params[0],
                    archived_at: params[1],
                    payload_json: params[2],
                });
            }
            if (sql.includes('archived_at = ?') && sql.includes('dismissed_at IS NULL')) {
                messages.forEach((m) => {
                    if (!m.dismissed_at && !m.archived_at) m.archived_at = params[0];
                });
            }
            if (sql.includes('DELETE FROM ticker')) { /* noop */ }
            if (sql.includes("setting_name = 'Shift_Notes'")) settings.Shift_Notes = '';
            if (sql.includes("setting_name='Critical_Alert'")) settings.Critical_Alert = '0';
        },
        getSettings() { return { ...settings }; },
    };
}

test('insertMessage replaces human pin and stores ticker rows', () => {
    const db = mockDb();
    insertMessage(db, { lane: 'pinned', body: 'TRUCK DELAYED', posted_by: 'MGR' });
    insertMessage(db, { lane: 'pinned', body: 'USE BACK DOCK', posted_by: 'MGR' });
    const activePinned = db.messages.filter((m) => m.lane === 'pinned' && !m.dismissed_at);
    assert.equal(activePinned.length, 1);
    assert.equal(activePinned[0].body, 'USE BACK DOCK');
    assert.equal(db.messages.filter((m) => m.lane === 'pinned' && m.dismissed_at).length, 1);

    const id = insertMessage(db, { lane: 'ticker', body: 'CS HOLD MONIN', posted_by: 'LEAD' });
    assert.ok(id.startsWith('CM-'));
});

test('system dedupe_key updates existing feed row', () => {
    const db = mockDb();
    insertMessage(db, {
        lane: 'feed',
        body: '3 items pull today',
        source: 'system',
        posted_by: 'SYSTEM',
        dedupe_key: 'system:pull-today:2026-05-19',
        replaceHumanPin: false,
    });
    insertMessage(db, {
        lane: 'feed',
        body: '5 items pull today',
        source: 'system',
        posted_by: 'SYSTEM',
        dedupe_key: 'system:pull-today:2026-05-19',
        replaceHumanPin: false,
    });
    const active = db.messages.filter((m) => !m.dismissed_at);
    assert.equal(active.length, 1);
    assert.equal(active[0].body, '5 items pull today');
});

test('buildCommsSyncPayload respects Message_Center_Enabled rollback flag', () => {
    const db = mockDb();
    insertMessage(db, { lane: 'feed', body: 'TEST FEED', posted_by: 'A' });
    const on = buildCommsSyncPayload(db, db.getSettings(), {
        settings: db.getSettings(),
        storeDate: '2026-05-19',
        storeWeekday: 'Tuesday',
        storeTime: '08:00',
        kpis: {},
    });
    assert.equal(on.enabled, true);
    assert.equal(on.feed.length, 1);

    db.settings.Message_Center_Enabled = '0';
    const off = buildCommsSyncPayload(db, db.getSettings(), {
        settings: db.getSettings(),
        storeDate: '2026-05-19',
        storeWeekday: 'Tuesday',
        storeTime: '08:00',
        kpis: {},
    });
    assert.equal(off.enabled, false);
    assert.equal(isMessageCenterEnabled(db.getSettings()), false);
});

test('archiveCommsForEod writes handoff snapshot', () => {
    const db = mockDb();
    insertMessage(db, { lane: 'ticker', body: 'DOCK BUSY', posted_by: 'LEAD' });
    archiveCommsForEod(db, '2026-05-19');
    assert.equal(db.messages.every((m) => m.archived_at), true);
    const handoff = getHandoffForReportDate(db, '2026-05-19');
    assert.ok(handoff);
    assert.equal(handoff.messages.length, 1);
});

test('promoteToPinned moves feed message to pinned lane', () => {
    const db = mockDb();
    const id = insertMessage(db, { lane: 'feed', body: 'CHECK A5', posted_by: 'LEAD' });
    promoteToPinned(db, id, 'MGR');
    const row = db.messages.find((m) => m.msg_id === id);
    assert.equal(row.lane, 'pinned');
});

test('filterMessagesForViewer hides zone-specific rows without a viewer zone', () => {
    const rows = [
        { msg_id: '1', body: 'ALL HANDS', zone: '' },
        { msg_id: '2', body: 'A5 ONLY', zone: 'A5' },
        { msg_id: '3', body: 'GENERAL TAG', zone: 'General' },
    ];
    const storeWide = filterMessagesForViewer(rows, { zone: '' });
    assert.equal(storeWide.length, 2);
    assert.ok(storeWide.some((r) => r.msg_id === '1'));
    assert.ok(storeWide.some((r) => r.msg_id === '3'));

    const a5 = filterMessagesForViewer(rows, { zone: 'A5' });
    assert.equal(a5.length, 3);

    const showAll = filterMessagesForViewer(rows, { showAll: true });
    assert.equal(showAll.length, 3);
});

test('dismissed system feed message stays dismissed across sync (floor comms)', () => {
    const db = mockDb();
    db.settings.Comms_System_Messages = '1';
    db.settings.Daily_Rhythm_Last_Loaded = '';
    const ctx = {
        settings: db.settings,
        storeDate: '2026-05-19',
        storeWeekday: 'Tuesday',
        storeTime: '07:00',
        kpis: {},
    };

    syncSystemMessages(db, ctx);
    const rhythm = db.messages.find((m) => m.dedupe_key === 'system:rhythm-not-loaded:2026-05-19');
    assert.ok(rhythm);
    dismissMessage(db, rhythm.msg_id, 'MGR');

    syncSystemMessages(db, ctx);
    const after = db.messages.filter((m) => m.dedupe_key === 'system:rhythm-not-loaded:2026-05-19' && !m.dismissed_at && !m.archived_at);
    assert.equal(after.length, 0, 'dismiss must not be undone by the next system sync');
});

test('dismissed system message can reappear after condition clears then returns', () => {
    const db = mockDb();
    db.settings.Comms_System_Messages = '1';
    db.settings.Daily_Rhythm_Last_Loaded = '';
    const ctx = {
        settings: db.settings,
        storeDate: '2026-05-19',
        storeWeekday: 'Tuesday',
        storeTime: '07:00',
        kpis: {},
    };

    syncSystemMessages(db, ctx);
    const first = db.messages.find((m) => m.dedupe_key === 'system:rhythm-not-loaded:2026-05-19');
    dismissMessage(db, first.msg_id, 'MGR');

    // Condition clears → dismissed row is archived so a later re-trigger can post again.
    db.settings.Daily_Rhythm_Last_Loaded = '2026-05-19';
    syncSystemMessages(db, ctx);
    assert.ok(first.archived_at, 'expected dismissed system row archived when condition cleared');

    db.settings.Daily_Rhythm_Last_Loaded = '';
    syncSystemMessages(db, ctx);
    const active = db.messages.filter((m) => m.dedupe_key === 'system:rhythm-not-loaded:2026-05-19' && !m.dismissed_at && !m.archived_at);
    assert.equal(active.length, 1, 'expected a fresh system message after condition returned');
});

test('system message self-retracts once its condition clears (rhythm loaded)', () => {
    const db = mockDb();
    db.settings.Comms_System_Messages = '1';
    db.settings.Daily_Rhythm_Last_Loaded = ''; // not loaded yet
    const ctx = {
        settings: db.settings,
        storeDate: '2026-05-19',
        storeWeekday: 'Tuesday',
        storeTime: '07:00', // past the 06:30 threshold
        kpis: {},
    };

    // First sync after 06:30 with rhythm not loaded → warning posts.
    syncSystemMessages(db, ctx);
    let rhythm = db.messages.find((m) => m.dedupe_key === 'system:rhythm-not-loaded:2026-05-19');
    assert.ok(rhythm, 'expected the rhythm-not-loaded warning to post');
    assert.equal(rhythm.dismissed_at, undefined);

    // Manager loads the rhythm → next sync should take the warning down.
    db.settings.Daily_Rhythm_Last_Loaded = '2026-05-19';
    syncSystemMessages(db, ctx);
    rhythm = db.messages.find((m) => m.dedupe_key === 'system:rhythm-not-loaded:2026-05-19');
    assert.ok(rhythm.dismissed_at, 'expected the warning to auto-dismiss once loaded');
});

test('insertMessage stores zone on post', () => {
    const db = mockDb();
    insertMessage(db, { lane: 'feed', body: 'AISLE CHECK', posted_by: 'LEAD', zone: 'A3' });
    assert.equal(db.messages[0].zone, 'A3');
});
