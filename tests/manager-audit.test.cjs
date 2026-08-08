'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { logManagerAudit, listManagerAudit, safeJson } = require('../src/lib/audit-log.cjs');

function makeAuditDb() {
    const rows = [];
    return {
        rows,
        run(sql, ...params) {
            assert.ok(sql.includes('INSERT INTO manager_audit_log'));
            const [
                created_at, actor_staff_id, actor_name, action, target_type, target_id,
                summary, metadata_json, ip_address, user_agent,
            ] = params;
            rows.push({
                id: rows.length + 1,
                created_at,
                actor_staff_id,
                actor_name,
                action,
                target_type,
                target_id,
                summary,
                metadata_json,
                ip_address,
                user_agent,
            });
            return { changes: 1 };
        },
        all(sql, limit, offset) {
            assert.ok(sql.includes('FROM manager_audit_log'));
            return rows.slice().reverse().slice(offset, offset + limit);
        },
    };
}

test('logManagerAudit records actor, request context, and metadata', () => {
    const db = makeAuditDb();
    const ok = logManagerAudit(db, {
        req: { ip: '192.168.1.44', headers: { 'user-agent': 'UnitTest' } },
        session: { name: 'TRAINING MODE', role: 'Manager' },
        action: 'settings_update',
        targetType: 'settings',
        targetId: 'Allow_LAN_Clients',
        summary: 'Changed setting Allow_LAN_Clients',
        metadata: { fields_changed: ['setting_value'] },
    });

    assert.equal(ok, true);
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].actor_name, 'TRAINING MODE');
    assert.equal(db.rows[0].action, 'settings_update');
    assert.equal(db.rows[0].target_id, 'Allow_LAN_Clients');
    assert.equal(db.rows[0].ip_address, '192.168.1.44');
    assert.deepEqual(JSON.parse(db.rows[0].metadata_json), { fields_changed: ['setting_value'] });
});

test('listManagerAudit returns recent events with parsed metadata', () => {
    const db = makeAuditDb();
    logManagerAudit(db, { action: 'one', metadata: { n: 1 } });
    logManagerAudit(db, { action: 'two', metadata: { n: 2 } });

    const events = listManagerAudit(db, { limit: 1 });
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'two');
    assert.deepEqual(events[0].metadata, { n: 2 });
});

test('safeJson truncates very large metadata', () => {
    const json = safeJson({ data: 'x'.repeat(5000) });
    const parsed = JSON.parse(json);
    assert.equal(parsed.truncated, true);
    assert.ok(parsed.preview.length <= 4000);
});
