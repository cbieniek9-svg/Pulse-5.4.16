'use strict';

const DEVICE_PURPOSES = new Set(['tv', 'cs_desk', 'receiving', 'markdown']);

const DEVICE_ACTION_CAPABILITIES = new Set([
    'cs_desk:special_orders:insert',
    'cs_desk:special_orders:update',
    'receiving:expected_orders:receiving_mark_arrived',
    'receiving:expected_orders:receiving_mark_departed',
    'receiving:expected_orders:receiving_log_arrival',
    'markdown:kill_dates:insert',
]);

function normalizeDevicePurpose(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return DEVICE_PURPOSES.has(normalized) ? normalized : '';
}

function canDevicePerform(purpose, table, action) {
    const normalizedPurpose = normalizeDevicePurpose(purpose);
    if (!normalizedPurpose || typeof table !== 'string' || typeof action !== 'string') return false;
    return DEVICE_ACTION_CAPABILITIES.has(`${normalizedPurpose}:${table}:${action}`);
}

module.exports = {
    DEVICE_PURPOSES,
    normalizeDevicePurpose,
    canDevicePerform,
};
