'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runMigrations } = require('../src/migrations/runner.cjs');
const {
    writeCloseOutbox,
    flushCloseAuditOutbox,
} = require('../src/lib/edmonton-receiving-integrity.cjs');

function withTestDb(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'close-outbox-'));
    const previous = process.env.TGP_DATA_DIR;
    process.env.TGP_DATA_DIR = tmp;
    let openedDb = null;
    try {
        delete require.cache[require.resolve('../src/db.cjs')];
        const { db, initializeSettings, initializeDailyRhythm } = require('../src/db.cjs');
        openedDb = db;
        initializeSettings();
        initializeDailyRhythm();
        runMigrations(db);
        return fn(db);
    } finally {
        try { openedDb?.close(); } catch (_) { /* test cleanup */ }
        process.env.TGP_DATA_DIR = previous;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

test('audit writer false leaves close outbox pending and retry flushes exactly once', () => {
    withTestDb((db) => {
        const eventId = 'close:2026-06-01:revision:1';
        writeCloseOutbox(db, {
            periodStart: '2026-06-01',
            eventType: 'receiving_period_locked',
            eventId,
            payload: { actor: 'Manager B' },
        });
        writeCloseOutbox(db, {
            periodStart: '2026-06-01',
            eventType: 'receiving_period_locked',
            eventId,
            payload: { actor: 'Manager B' },
        });
        assert.equal(
            db.get('SELECT COUNT(*) AS n FROM receiving_report_close_audit_outbox').n,
            1,
        );

        const failed = flushCloseAuditOutbox(db, '2026-06-01', {
            logManagerAudit: () => false,
        });
        assert.equal(failed.flushed, 0);
        assert.equal(failed.failed, 1);
        assert.equal(
            db.get('SELECT COUNT(*) AS n FROM receiving_report_close_audit_outbox WHERE flushed_at IS NULL').n,
            1,
        );

        const success = flushCloseAuditOutbox(db, '2026-06-01');
        assert.equal(success.flushed, 1);
        assert.equal(
            db.get('SELECT COUNT(*) AS n FROM manager_audit_log WHERE source_event_id=?', eventId).n,
            1,
        );

        const retry = flushCloseAuditOutbox(db, '2026-06-01');
        assert.equal(retry.flushed, 0);
        assert.equal(
            db.get('SELECT COUNT(*) AS n FROM manager_audit_log WHERE source_event_id=?', eventId).n,
            1,
        );
    });
});

