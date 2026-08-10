#!/usr/bin/env node
'use strict';
/**
 * Compare store snapshot JSON files (scorecard and/or zone export).
 * Usage:
 *   node scripts/hq-snapshot-compare.cjs store-a.json store-b.json
 *
 * Legacy scorecard-only:
 *   { "store_code": "TGP01", "order_weekly_scorecard": { ... } }
 *
 * Zone export (export-zone-snapshot.cjs shape):
 *   { "store_display_name": "...", "Zone_Mapping": "...", ... }
 *
 * Combined exports may nest scorecard under order_weekly_scorecard alongside zone fields.
 * Scorecard and zone capabilities are tracked independently so combined snapshots can
 * participate in either comparison when every input supports that capability.
 */
const fs = require('fs');
const path = require('path');
const { normalizeSnapshot } = require('./lib/zone-snapshot-format.cjs');

function extractScorecard(data) {
    const scorecard = data.order_weekly_scorecard
        || data.scorecard
        || data.reports?.order_weekly_scorecard
        || data.reports_payload?.order_weekly_scorecard;
    return scorecard?.by_weekday ? scorecard : null;
}

function isZoneExport(data) {
    return !!(data.zone_mapping || data.Zone_Mapping || data.zone_ownership || data.Zone_Ownership);
}

function loadSnapshot(filePath) {
    const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
    const data = JSON.parse(raw);
    const scorecard = extractScorecard(data);
    const zone = isZoneExport(data) ? normalizeSnapshot(data) : null;
    const store_code = data.store_code
        || data.store?.code
        || zone?.store_display_name
        || path.basename(filePath, '.json');
    if (!scorecard && !zone) {
        throw new Error(`${filePath}: not a recognized scorecard or zone-export snapshot`);
    }
    return {
        file: filePath,
        store_code,
        scorecard,
        zone,
        hasScorecard: !!scorecard,
        hasZone: !!zone,
    };
}

function formatRow(label, stores, picker) {
    const cells = stores.map((s) => {
        const v = picker(s);
        return v == null ? '—' : String(v);
    });
    console.log(`${label.padEnd(14)} | ${cells.join(' | ')}`);
}

function zoneSectionCount(zone, zoneName) {
    const mapping = zone.zone_mapping || {};
    return (mapping[zoneName] || []).length;
}

function compareScorecards(stores) {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    console.log('\n=== HQ Snapshot Compare (scorecard) ===\n');
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

function compareZones(stores) {
    const zones = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4'];

    console.log('\n=== HQ Snapshot Compare (zone export) ===\n');
    console.log(`Stores: ${stores.map((s) => s.store_code).join(', ')}\n`);

    formatRow('Store', stores, (s) => s.store_code);
    formatRow('Exported', stores, (s) => (s.zone.exported_at || '').slice(0, 10) || '—');
    formatRow('Source', stores, (s) => s.zone.source || '—');

    console.log('\n--- Zone names ---\n');
    zones.forEach((zone) => {
        formatRow(zone, stores, (s) => s.zone.zone_names?.[zone] || zone);
    });

    console.log('\n--- Zone owners ---\n');
    zones.forEach((zone) => {
        formatRow(zone, stores, (s) => s.zone.zone_ownership?.[zone] || '—');
    });

    console.log('\n--- Sections mapped ---\n');
    zones.forEach((zone) => {
        formatRow(zone, stores, (s) => zoneSectionCount(s.zone, zone));
    });
    console.log('');
}

function main() {
    const files = process.argv.slice(2);
    if (files.length < 2) {
        console.error('Provide at least two snapshot JSON files.');
        process.exit(1);
    }

    const stores = files.map(loadSnapshot);
    const allHaveScorecard = stores.every((s) => s.hasScorecard);
    const allHaveZone = stores.every((s) => s.hasZone);

    if (!allHaveScorecard && !allHaveZone) {
        console.error('No shared comparison capability: every input must include scorecard data, or every input must include zone-export data (combined snapshots may include both).');
        process.exit(1);
    }

    if (allHaveScorecard) compareScorecards(stores);
    if (allHaveZone) compareZones(stores);
}

main();
