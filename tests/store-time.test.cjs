'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStoreTimeAccessors, addDaysToDateStamp } = require('../src/lib/store-time.cjs');

test('getStoreDateStamp uses Store_Timezone setting', () => {
    const accessors = createStoreTimeAccessors(() => ({
        Store_Timezone: 'America/Toronto',
    }));
    const utcLate = new Date('2026-05-20T04:30:00.000Z');
    assert.equal(accessors.getStoreDateStamp(utcLate), '2026-05-20');
});

test('getStoreDateStamp differs from UTC when store TZ crosses midnight', () => {
    const accessors = createStoreTimeAccessors(() => ({
        Store_Timezone: 'America/Los_Angeles',
    }));
    const utcMorning = new Date('2026-05-20T06:00:00.000Z');
    assert.equal(accessors.getStoreDateStamp(utcMorning), '2026-05-19');
});

test('addDaysToDateStamp adds calendar days', () => {
    assert.equal(addDaysToDateStamp('2026-05-20', 7), '2026-05-27');
});

test('invalid Store_Timezone falls back without throwing', () => {
    const accessors = createStoreTimeAccessors(() => ({ Store_Timezone: 'Not/A/Zone' }));
    assert.doesNotThrow(() => accessors.getStoreDateStamp());
    assert.equal(accessors.getTimezone(), 'America/Toronto');
    const stamp = accessors.getStoreDateStamp(new Date('2026-05-20T17:30:00.000Z'));
    assert.match(stamp, /^\d{4}-\d{2}-\d{2}$/);
});

test('getStoreClockPayload includes timezone label fields', () => {
    const accessors = createStoreTimeAccessors(() => ({ Store_Timezone: 'America/Toronto' }));
    const clock = accessors.getStoreClockPayload(new Date('2026-05-20T17:30:00.000Z'));
    assert.equal(clock.storeTimezone, 'America/Toronto');
    assert.match(clock.storeDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(clock.storeTime);
    assert.ok(clock.storeDateLabel);
});
