'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    resolvePcAdminPin,
    inspectPcAdminPin,
    LEGACY_DEFAULT_PIN,
} = require('../src/lib/pc-admin-pin.cjs');

test('resolvePcAdminPin prefers secure env over generated PIN', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-pin-'));
    const resolved = resolvePcAdminPin({
        dataRoot: dir,
        env: { PC_ADMIN_PIN: '99887766' },
        db: { get: () => null },
    });
    assert.equal(resolved.pin, '99887766');
    assert.equal(resolved.source, 'env');
    assert.equal(resolved.insecureDefault, false);
});

test('fresh install mints pc-admin-pin.txt once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-pin-fresh-'));
    const db = {
        get(sql) {
            if (/FROM staff/i.test(sql)) return null;
            return null;
        },
    };
    const first = resolvePcAdminPin({ dataRoot: dir, env: {}, db });
    assert.equal(first.source, 'generated');
    assert.equal(first.insecureDefault, false);
    assert.match(first.pin, /^\d{8}$/);
    assert.equal(fs.existsSync(first.pinPath), true);

    const second = resolvePcAdminPin({ dataRoot: dir, env: {}, db });
    assert.equal(second.source, 'file');
    assert.equal(second.pin, first.pin);
});

test('upgrade without a manager mints the same secure PIN as fresh bootstrap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-pin-up-'));
    const db = {
        get(sql) {
            if (/role IN/i.test(sql)) return null;
            if (/FROM staff/i.test(sql)) return { ok: 1 };
            return null;
        },
    };
    const resolved = resolvePcAdminPin({ dataRoot: dir, env: {}, db });
    assert.match(resolved.pin, /^\d{8}$/);
    assert.notEqual(resolved.pin, LEGACY_DEFAULT_PIN);
    assert.equal(resolved.source, 'generated');
    assert.equal(resolved.insecureDefault, false);
    assert.equal(fs.readFileSync(resolved.pinPath, 'utf8').trim(), resolved.pin);

    const inspected = inspectPcAdminPin({ dataRoot: dir, env: {}, db });
    assert.equal(inspected.source, 'file');
    assert.equal(inspected.insecureDefault, false);
});

test('PC_ADMIN_PIN=1234 via env is insecure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-pin-env1234-'));
    const resolved = resolvePcAdminPin({
        dataRoot: dir,
        env: { PC_ADMIN_PIN: '1234' },
        db: { get: () => null },
    });
    assert.equal(resolved.insecureDefault, true);
    assert.equal(resolved.source, 'env');
    assert.equal(inspectPcAdminPin({
        dataRoot: dir,
        env: { PC_ADMIN_PIN: '1234' },
        db: { get: () => ({ ok: 1 }) },
    }).insecureDefault, true);
});

test('pc-admin-pin.txt containing 1234 is insecure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-pin-file1234-'));
    fs.writeFileSync(path.join(dir, 'pc-admin-pin.txt'), '1234\n');
    const resolved = resolvePcAdminPin({
        dataRoot: dir,
        env: {},
        db: { get: () => null },
    });
    assert.equal(resolved.source, 'file_invalid');
    assert.equal(resolved.pin, null);
    assert.equal(resolved.disabled, true);
});

test('Store Manager disables bootstrap even when no Manager exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-pin-store-manager-'));
    const queries = [];
    const db = {
        get(sql) {
            queries.push(sql);
            if (/role IN/i.test(sql)) return { ok: 1 };
            return null;
        },
    };
    const resolved = resolvePcAdminPin({ dataRoot: dir, env: {}, db });
    assert.equal(resolved.pin, null);
    assert.equal(resolved.source, 'disabled');
    assert.equal(fs.existsSync(resolved.pinPath), false);
    assert.ok(queries.some((sql) => /active/i.test(sql)));
});

test('manager query failure disables PC_ADMIN without generating a credential', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-pin-db-error-'));
    const resolved = resolvePcAdminPin({
        dataRoot: dir,
        env: { PC_ADMIN_PIN: '87654321' },
        db: { get: () => { throw new Error('injected database failure'); } },
    });
    assert.equal(resolved.pin, null);
    assert.equal(resolved.disabled, true);
    assert.equal(resolved.source, 'manager_check_failed');
    assert.equal(fs.existsSync(resolved.pinPath), false);
});

for (const [label, contents] of [
    ['malformed', 'not-a-pin\n'],
    ['oversized', `${' '.repeat(80)}87654321\n`],
]) {
    test(`${label} bootstrap PIN file fails closed without replacement`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tgp-pin-${label}-`));
        const pinPath = path.join(dir, 'pc-admin-pin.txt');
        fs.writeFileSync(pinPath, contents);
        const resolved = resolvePcAdminPin({ dataRoot: dir, env: {}, db: { get: () => null } });
        assert.equal(resolved.pin, null);
        assert.equal(resolved.source, 'file_invalid');
        assert.equal(fs.readFileSync(pinPath, 'utf8'), contents);
    });
}

test('non-file bootstrap PIN path fails closed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-pin-non-file-'));
    fs.mkdirSync(path.join(dir, 'pc-admin-pin.txt'));
    const resolved = resolvePcAdminPin({ dataRoot: dir, env: {}, db: { get: () => null } });
    assert.equal(resolved.pin, null);
    assert.equal(resolved.source, 'file_invalid');
});

test('bootstrap PIN file read errors fail closed without regeneration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-pin-read-error-'));
    let writeAttempted = false;
    const resolved = resolvePcAdminPin({
        dataRoot: dir,
        env: {},
        db: { get: () => null },
        fs: {
            lstatSync: () => ({ isFile: () => true, size: 9 }),
            readFileSync: () => { throw new Error('injected read failure'); },
            mkdirSync: () => {},
            writeFileSync: () => { writeAttempted = true; },
        },
    });
    assert.equal(resolved.pin, null);
    assert.equal(resolved.source, 'file_error');
    assert.equal(writeAttempted, false);
});

test('fresh bootstrap PIN file requests owner-only mode where supported', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-pin-mode-'));
    const resolved = resolvePcAdminPin({ dataRoot: dir, env: {}, db: { get: () => null } });
    assert.match(resolved.pin, /^\d{8}$/);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(resolved.pinPath).mode & 0o777, 0o600);
    }
});

test('EEXIST generation contention accepts only the winning valid regular file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-pin-contention-'));
    let reads = 0;
    let writeOptions;
    const fakeFs = {
        lstatSync() {
            if (reads++ === 0) {
                const error = new Error('missing');
                error.code = 'ENOENT';
                throw error;
            }
            return { isFile: () => true, size: 9 };
        },
        readFileSync: () => '87654321\n',
        mkdirSync: () => {},
        writeFileSync(_path, _contents, options) {
            writeOptions = options;
            const error = new Error('lost race');
            error.code = 'EEXIST';
            throw error;
        },
    };
    const resolved = resolvePcAdminPin({
        dataRoot: dir,
        env: {},
        db: { get: () => null },
        fs: fakeFs,
    });
    assert.equal(resolved.source, 'file');
    assert.equal(resolved.pin, '87654321');
    assert.equal(writeOptions.flag, 'wx');
    assert.equal(writeOptions.mode, 0o600);
});

test('inspectPcAdminPin reports metadata without returning plaintext PIN', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-pin-inspect-'));
    fs.writeFileSync(path.join(dir, 'pc-admin-pin.txt'), '87654321\n');
    const fromFile = inspectPcAdminPin({ dataRoot: dir, env: {}, db: { get: () => null } });
    const fromEnv = inspectPcAdminPin({
        dataRoot: dir,
        env: { PC_ADMIN_PIN: '11223344' },
        db: { get: () => null },
    });
    assert.deepEqual(
        { source: fromFile.source, configured: fromFile.configured, secure: fromFile.secure },
        { source: 'file', configured: true, secure: true },
    );
    assert.equal(Object.hasOwn(fromFile, 'pin'), false);
    assert.equal(Object.hasOwn(fromEnv, 'pin'), false);
});
