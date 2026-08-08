'use strict';

/**
 * Shared money parsing for receiving / financial writes.
 *
 * Invalid non-empty text must NOT become $0 — that is how typos understate a day.
 * roundMoney is for already-validated numbers and DB rollups only.
 */

function parseMoneyOrNull(value) {
    if (value === '' || value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;

    let text = String(value)
        .replace(/[\s\u00a0\u202f]/g, '')
        .replace(/[$£€¥]/g, '')
        .replace(/[\u2212\u2013\u2014]/g, '-')
        .replace(/,/g, '');
    if (!text) return null;

    let sign = 1;
    if (/^\(.*\)$/.test(text)) {
        sign = -1;
        text = text.slice(1, -1);
    }
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return null;

    const n = Number(text);
    return Number.isFinite(n) ? sign * n : null;
}

/** Empty / null → 0; invalid non-empty → null (caller must reject). */
function parseMoneyField(value) {
    if (value === '' || value == null) return 0;
    return parseMoneyOrNull(value);
}

function roundMoney(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.round(v * 100) / 100;
}

/**
 * Parse a money field from user/API input.
 * @returns {{ ok: true, value: number } | { ok: false, label: string }}
 */
function parseRequiredMoney(value, label) {
    if (value === '' || value == null) return { ok: true, value: 0 };
    const parsed = parseMoneyOrNull(value);
    if (parsed == null) return { ok: false, label: label || 'amount' };
    return { ok: true, value: roundMoney(parsed) };
}

/** Empty stays null; garbage throws 400 instead of banking $0. */
function parseOptionalMoneyOrThrow(value, label) {
    if (value === '' || value == null) return null;
    const parsed = parseMoneyOrNull(value);
    if (parsed == null) {
        const err = new Error(`Not a number: ${label || 'amount'}`);
        err.status = 400;
        throw err;
    }
    return roundMoney(parsed);
}

function parseMoneyOrThrow(value, label) {
    const result = parseRequiredMoney(value, label);
    if (!result.ok) {
        const err = new Error(`Not a number: ${result.label}`);
        err.status = 400;
        throw err;
    }
    return result.value;
}

module.exports = {
    parseMoneyOrNull,
    parseMoneyField,
    parseRequiredMoney,
    parseOptionalMoneyOrThrow,
    parseMoneyOrThrow,
    roundMoney,
};
