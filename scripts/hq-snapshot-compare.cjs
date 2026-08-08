#!/usr/bin/env node
'use strict';
/**
 * Compare weekly order scorecards from exported store snapshot JSON files.
 * Usage:
 *   node scripts/hq-snapshot-compare.cjs store-a.json store-b.json
 *
 * Each snapshot JSON should include:
 *   { "store_code": "TGP01", "order_weekly_scorecard": { ... } }
 */
const fs = require('fs');
const path = require('path');

function loadSnapshot(filePath) {
    const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
    const data = JSON.parse(raw);
    const code = data.store_code || data.store?.code || path.basename(filePath, '.json');
    const scorecard = data.order_weekly_scorecard || data.scorecard;
    if (!scorecard?.by_weekday) {
        throw new Error(`${filePath}: missing order_weekly_scorecard.by_weekday`);
    }
    return { file: filePath, store_code: code, scorecard };
}

function formatRow(label, stores, picker) {
    const cells = stores.map((s) => {
        const v = picker(s);
        return v == null ? '—' : String(v);
    });
    console.log(`${label.padEnd(14)} | ${cells.join(' | ')}`);
}

function main() {
    const files = process.argv.slice(2);
    if (files.length < 2) {
        console.error('Provide at least two snapshot JSON files.');
        process.exit(1);
    }

    const stores = files.map(loadSnapshot);
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    console.log('\n=== HQ Snapshot Compare ===\n');
    console.log(`Stores: ${stores.map((s) => s.store_code).join(', ')}\n`);

    formatRow('Store', stores, (s) => s.store_code);
    formatRow('Order days', stores, (s) => s.scorecard.order_days ?? '—');
    formatRow('Avg pieces', stores, (s) => s.scorecard.overall?.avg_pieces ?? '—');
    formatRow('Avg team PPH', stores, (s) => s.scorecard.overall?.avg_team_pph ?? '—');
    formatRow('Avg adj/person', stores, (s) => s.scorecard.overall?.avg_adj_pph ?? '—');

    console.log('\n--- By weekday (avg pieces) ---\n');
    weekdays.forEach((wd) => {
        formatRow(wd, stores, (s) => {
            const row = (s.scorecard.by_weekday || []).find((r) => r.weekday === wd);
            return row?.avg_pieces ?? '—';
        });
    });
    console.log('');
}

main();
