'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listMarkdownArchive, findMarkdownDuplicates } = require('../src/lib/markdown-archive.cjs');

const SEED = [
    { id: '1', item: 'Yogurt Cup', item_code: '111', kill_date: '2026-08-01', zone: 'Dairy', status: 'Active', logged_by: 'Sam', closed_by: null, time_closed: null, quantity: 2 },
    { id: '2', item: 'Yogurt Cup', item_code: '111', kill_date: '2026-07-01', zone: 'Dairy', status: 'Archived', logged_by: 'Sam', closed_by: 'Mgr', time_closed: '2026-07-02', quantity: 1 },
    { id: '3', item: 'Bread', item_code: '222', kill_date: '2026-08-05', zone: 'Bakery', status: 'Closed', logged_by: 'Jess', closed_by: 'Jess', time_closed: '2026-08-04', quantity: 3 },
    { id: '4', item: 'Milk', item_code: '333', kill_date: '2026-08-10', zone: 'Dairy', status: 'Deleted', logged_by: 'Ash', closed_by: null, time_closed: null, quantity: 1 },
];

function makeDb(rows = SEED) {
    return {
        get(sql, ...params) {
            if (sql.includes('COUNT(*)') && sql.includes('GROUP BY')) return null;
            const filtered = filterRows(rows, sql, params);
            return { c: filtered.length };
        },
        all(sql, ...params) {
            if (sql.includes('GROUP BY status')) {
                const map = {};
                for (const r of rows) map[r.status] = (map[r.status] || 0) + 1;
                return Object.entries(map).map(([status, c]) => ({ status, c }));
            }
            if (sql.includes('LOWER(TRIM(COALESCE(item_code')) {
                const code = String(params[0] || '').toLowerCase();
                return rows.filter((r) => String(r.item_code || '').trim().toLowerCase() === code).slice(0, 40);
            }
            if (sql.includes("LOWER(TRIM(COALESCE(item,''))) = ?")) {
                const item = String(params[0] || '').toLowerCase();
                const zone = String(params[2] || '');
                return rows.filter((r) => {
                    if (String(r.item || '').trim().toLowerCase() !== item) return false;
                    if (zone && r.zone !== zone) return false;
                    return true;
                }).slice(0, 40);
            }
            const filtered = filterRows(rows, sql, params);
            const limit = params[params.length - 2];
            const offset = params[params.length - 1];
            return filtered.slice(offset, offset + limit);
        },
    };
}

function filterRows(rows, sql, params) {
    let out = [...rows];
    let pi = 0;
    if (sql.includes("status != 'Active'")) {
        out = out.filter((r) => r.status !== 'Active');
    } else if (sql.includes('status = ?')) {
        const status = params[pi++];
        out = out.filter((r) => r.status === status);
    }
    if (sql.includes('zone = ?') && !sql.includes("LOWER(TRIM(COALESCE(item,'')))")) {
        const zone = params[pi++];
        out = out.filter((r) => r.zone === zone);
    }
    if (sql.includes('LIKE ?')) {
        const like = String(params[pi] || '').replace(/%/g, '').toLowerCase();
        out = out.filter((r) =>
            String(r.item || '').toLowerCase().includes(like)
            || String(r.item_code || '').toLowerCase().includes(like)
            || String(r.logged_by || '').toLowerCase().includes(like));
    }
    return out;
}

test('listMarkdownArchive defaults to all statuses with paging', () => {
    const result = listMarkdownArchive(makeDb(), { status: 'all', limit: 2, offset: 0 });
    assert.equal(result.total, 4);
    assert.equal(result.rows.length, 2);
    assert.equal(result.counts.Active, 1);
    assert.equal(result.counts.Archived, 1);
});

test('listMarkdownArchive status=archived excludes Active', () => {
    const result = listMarkdownArchive(makeDb(), { status: 'archived' });
    assert.equal(result.total, 3);
    assert.ok(result.rows.every((r) => r.status !== 'Active'));
});

test('listMarkdownArchive searches item_code', () => {
    const result = listMarkdownArchive(makeDb(), { q: '111', status: 'all' });
    assert.equal(result.total, 2);
    assert.ok(result.rows.every((r) => r.item_code === '111'));
});

test('findMarkdownDuplicates flags active vendor code as risk', () => {
    const result = findMarkdownDuplicates(makeDb(), { item_code: '111', kill_date: '2026-09-01' });
    assert.equal(result.risk, 'active');
    assert.equal(result.active.length, 1);
    assert.equal(result.archived.length, 1);
});

test('findMarkdownDuplicates same_date when only archived matches date', () => {
    const result = findMarkdownDuplicates(makeDb(), { item_code: '222', kill_date: '2026-08-05' });
    assert.equal(result.risk, 'same_date');
    assert.equal(result.same_date.length, 1);
});
