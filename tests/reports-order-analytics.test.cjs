'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildRosterPerformanceRollup,
    buildRosterSuggestionsByWeekday,
    rosterKey,
    parseStaffRoster,
} = require('../src/lib/reports-order-analytics.cjs');

test('rosterKey ignores name order', () => {
    assert.equal(rosterKey(['Alex', 'Sam']), rosterKey(['Sam', 'Alex']));
});

test('buildRosterPerformanceRollup groups matching crews and ranks by adj PPH', () => {
    const rollup = buildRosterPerformanceRollup([
        {
            store_date: '2026-06-01',
            staff_roster: ['Alex', 'Sam'],
            total_pieces: 600,
            actual_order_minutes: 120,
            actual_pieces_per_hour: 300,
            adjusted_per_person_pph: 160,
        },
        {
            store_date: '2026-06-08',
            staff_roster: ['Sam', 'Alex'],
            total_pieces: 500,
            actual_order_minutes: 120,
            actual_pieces_per_hour: 250,
            adjusted_per_person_pph: 140,
        },
        {
            store_date: '2026-06-02',
            staff_roster: ['Jordan', 'Casey', 'Riley'],
            total_pieces: 700,
            actual_order_minutes: 150,
            actual_pieces_per_hour: 280,
            adjusted_per_person_pph: 120,
        },
    ]);
    assert.equal(rollup.length, 2);
    assert.equal(rollup[0].samples, 2);
    assert.match(rollup[0].roster_label, /Alex/);
    assert.equal(rollup[0].avg_adj_pph, 150);
    assert.equal(rollup[1].staff_count, 3);
});

test('parseStaffRoster accepts comma-separated strings', () => {
    assert.deepEqual(parseStaffRoster('Alex, Sam; Jordan'), ['Alex', 'Sam', 'Jordan']);
});

test('buildRosterSuggestionsByWeekday ranks crews within each order weekday', () => {
    const suggestions = buildRosterSuggestionsByWeekday([
        {
            store_date: '2026-06-07',
            staff_roster: ['Alex', 'Sam'],
            total_pieces: 600,
            actual_order_minutes: 120,
            actual_pieces_per_hour: 300,
            adjusted_per_person_pph: 160,
        },
        {
            store_date: '2026-06-09',
            staff_roster: ['Jordan', 'Casey'],
            total_pieces: 500,
            actual_order_minutes: 120,
            actual_pieces_per_hour: 250,
            adjusted_per_person_pph: 140,
        },
        {
            store_date: '2026-06-11',
            staff_roster: ['Jordan', 'Casey', 'Riley'],
            total_pieces: 700,
            actual_order_minutes: 150,
            actual_pieces_per_hour: 280,
            adjusted_per_person_pph: 120,
        },
    ]);
    const sunday = suggestions.by_weekday.find((d) => d.weekday === 'Sunday');
    const tuesday = suggestions.by_weekday.find((d) => d.weekday === 'Tuesday');
    const thursday = suggestions.by_weekday.find((d) => d.weekday === 'Thursday');
    assert.equal(sunday.suggestions[0].roster_label.includes('Alex'), true);
    assert.equal(sunday.suggestions[0].rank, 1);
    assert.equal(tuesday.suggestions[0].roster_label.includes('Jordan'), true);
    assert.equal(thursday.suggestions[0].staff_count, 3);
});
