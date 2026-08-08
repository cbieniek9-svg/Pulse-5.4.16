'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    vendorAliasKey,
    normalizeVendorInput,
    listCanonicalVendors,
    normalizeExistingReceivingVendors,
} = require('../src/lib/vendor-canonical.cjs');

function distinct(rows, col) {
    return Array.from(new Set(rows.map((r) => r[col]).filter(Boolean))).map((vendor) => ({ vendor }));
}

function createMiniDb() {
    const state = {
        aliases: new Map(),
        expected_orders: [
            { vendor: 'coke' },
            { vendor: 'pesis' },
            { vendor: 'Canada bread' },
            { vendor: 'vvvcv' },
        ],
        receiving_stats: [
            { vendor: 'pepsi' },
        ],
        vendor_schedule: [
            { vendor: 'complete' },
        ],
    };

    return {
        state,
        exec() {},
        run(sql, ...params) {
            if (/INSERT OR IGNORE INTO receiving_vendor_aliases/i.test(sql)) {
                const [alias_key, alias_text, canonical_vendor, active, source, created_at, updated_at] = params;
                if (!state.aliases.has(alias_key)) {
                    state.aliases.set(alias_key, {
                        alias_key,
                        alias_text,
                        canonical_vendor,
                        active,
                        source,
                        created_at,
                        updated_at,
                    });
                    return { changes: 1 };
                }
                return { changes: 0 };
            }
            const updateMatch = /UPDATE\s+(\w+)\s+SET\s+vendor=\?\s+WHERE\s+vendor=\?/i.exec(sql);
            if (updateMatch) {
                const [, table] = updateMatch;
                const [next, prev] = params;
                let changes = 0;
                (state[table] || []).forEach((row) => {
                    if (row.vendor === prev) {
                        row.vendor = next;
                        changes += 1;
                    }
                });
                return { changes };
            }
            return { changes: 0 };
        },
        get(sql, ...params) {
            if (/SELECT canonical_vendor FROM receiving_vendor_aliases/i.test(sql)) {
                const row = state.aliases.get(params[0]);
                return row && row.active ? { canonical_vendor: row.canonical_vendor } : undefined;
            }
            return undefined;
        },
        all(sql) {
            if (/SELECT DISTINCT canonical_vendor AS vendor/i.test(sql)) {
                return Array.from(state.aliases.values())
                    .filter((r) => r.active)
                    .map((r) => ({ vendor: r.canonical_vendor }));
            }
            if (/SELECT DISTINCT vendor FROM expected_orders/i.test(sql)) return distinct(state.expected_orders, 'vendor');
            if (/SELECT DISTINCT vendor FROM vendor_schedule/i.test(sql)) return distinct(state.vendor_schedule, 'vendor');

            const tableMatch = /SELECT DISTINCT vendor AS vendor FROM (\w+)/i.exec(sql);
            if (tableMatch) return distinct(state[tableMatch[1]] || [], 'vendor');
            return [];
        },
    };
}

test('vendor alias keys normalize casing and punctuation', () => {
    assert.equal(vendorAliasKey('  G&L   Distributors '), 'g and l distributors');
    assert.equal(vendorAliasKey('Frito Lay (Retail)'), 'frito lay retail');
});

test('known vendor typos are normalized but unknown values are not guessed', () => {
    const db = createMiniDb();
    assert.equal(normalizeVendorInput(db, 'coke'), 'Coke');
    assert.equal(normalizeVendorInput(db, 'pesis'), 'Pepsi');
    assert.equal(normalizeVendorInput(db, 'Canada bread'), 'Canada Bread');
    assert.equal(normalizeVendorInput(db, 'vvvcv'), 'Vvvcv');
});

test('existing receiving vendor rows normalize obvious aliases', () => {
    const db = createMiniDb();
    const changed = normalizeExistingReceivingVendors(db);
    assert.ok(changed >= 5);
    assert.deepEqual(db.state.expected_orders.map((r) => r.vendor), [
        'Coke',
        'Pepsi',
        'Canada Bread',
        'Vvvcv',
    ]);
    assert.equal(db.state.receiving_stats[0].vendor, 'Pepsi');
    assert.equal(db.state.vendor_schedule[0].vendor, 'Complete');
});

test('canonical vendor list includes seeded and historical names', () => {
    const db = createMiniDb();
    const vendors = listCanonicalVendors(db);
    assert.ok(vendors.includes('Coke'));
    assert.ok(vendors.includes('Pepsi'));
    assert.ok(vendors.includes('Canada Bread'));
    assert.ok(vendors.includes('Frito Lay (Retail)'));
});
