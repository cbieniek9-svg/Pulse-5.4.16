'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProductionReadinessReport, settingBool } = require('../src/lib/production-readiness.cjs');

function mockDb({
    settings = {},
    ipFallbackCount = 0,
    deviceState = null,
    trainingStaff = null,
} = {}) {
    return {
        getSettings: () => settings,
        get(sql, name) {
            if (/FROM trusted_devices/i.test(sql)) {
                return deviceState || {
                    authorized_devices: ipFallbackCount,
                    missing_token: ipFallbackCount,
                    missing_purpose: 0,
                    missing_token_or_purpose: ipFallbackCount,
                };
            }
            if (/FROM staff/i.test(sql) && /TRAINING MODE/i.test(sql)) {
                if (trainingStaff == null) {
                    return { n: 0, active: 0, app_access: 0 };
                }
                return {
                    n: Number(trainingStaff.n != null ? trainingStaff.n : 1),
                    active: Number(trainingStaff.active || 0),
                    app_access: Number(trainingStaff.app_access || 0),
                };
            }
            if (/FROM settings/i.test(sql) && Object.prototype.hasOwnProperty.call(settings, name)) {
                return { setting_value: settings[name] };
            }
            return null;
        },
    };
}

function healthyHealth() {
    return {
        status: 'ok',
        errors: [],
        warnings: [],
        checks: {
            backups: {
                ok: true,
                latest_file: 'tgp_ops_backup_2026-06-21.db',
                latest_readable: true,
                latest_verified: true,
                latest_verify_error: null,
                latest_age_hours: 2,
                max_age_hours: 72,
            },
        },
    };
}

function healthySettings(extra = {}) {
    return {
        Training_Mode_Enabled: '0',
        Require_TV_Device_Token: '1',
        Store_Instance_Id: '11111111-2222-4333-8444-555555555555',
        Store_Code: 'STORE-001',
        ...extra,
    };
}

function withSecurePin(fn) {
    const prevPin = process.env.PC_ADMIN_PIN;
    process.env.PC_ADMIN_PIN = '87654321';
    try {
        return fn();
    } finally {
        if (prevPin === undefined) delete process.env.PC_ADMIN_PIN;
        else process.env.PC_ADMIN_PIN = prevPin;
    }
}

function withEnv(vars, fn) {
    const prev = {};
    for (const [key, value] of Object.entries(vars)) {
        prev[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return fn();
    } finally {
        for (const [key, value] of Object.entries(prev)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function checkById(report, id) {
    return report.checks.find((item) => item.id === id);
}

test('settingBool accepts common enabled and disabled values', () => {
    assert.equal(settingBool({ A: '1' }, 'A'), true);
    assert.equal(settingBool({ A: 'true' }, 'A'), true);
    assert.equal(settingBool({ A: '0' }, 'A', true), false);
    assert.equal(settingBool({}, 'A', true), true);
});

test('Training_Mode_Enabled makes readiness error independently', () => {
    withSecurePin(() => {
        const report = buildProductionReadinessReport({
            db: mockDb({ settings: healthySettings({ Training_Mode_Enabled: '1' }) }),
            health: healthyHealth(),
            network: { allow_lan_clients: false, bind_host: '127.0.0.1', port: 3001, https_active: false, warnings: [] },
            now: new Date('2026-06-21T12:00:00Z'),
        });
        const training = checkById(report, 'training_mode');
        assert.equal(training.status, 'error');
        assert.equal(report.ok, false);
        assert.equal(report.status, 'error');
        assert.match(training.summary, /disable|training/i);
    });
});

test('active TRAINING MODE staff row makes readiness error independently', () => {
    withSecurePin(() => {
        const report = buildProductionReadinessReport({
            db: mockDb({
                settings: healthySettings(),
                trainingStaff: { n: 1, active: 1, app_access: 0 },
            }),
            health: healthyHealth(),
            network: { allow_lan_clients: false, bind_host: '127.0.0.1', port: 3001, https_active: false, warnings: [] },
        });
        const training = checkById(report, 'training_mode');
        assert.equal(training.status, 'error');
        assert.equal(report.ok, false);
        assert.equal(report.status, 'error');
        assert.match(training.summary, /TRAINING MODE|training staff|active|app_access/i);
    });
});

test('app_access-enabled TRAINING MODE staff row makes readiness error independently', () => {
    withSecurePin(() => {
        const report = buildProductionReadinessReport({
            db: mockDb({
                settings: healthySettings(),
                trainingStaff: { n: 1, active: 0, app_access: 1 },
            }),
            health: healthyHealth(),
            network: { allow_lan_clients: false, bind_host: '127.0.0.1', port: 3001, https_active: false, warnings: [] },
        });
        const training = checkById(report, 'training_mode');
        assert.equal(training.status, 'error');
        assert.equal(report.ok, false);
        assert.match(training.summary, /TRAINING MODE|training staff|app_access|access/i);
    });
});

test('insecure PC_ADMIN PIN makes readiness error independently', () => {
    withEnv({ PC_ADMIN_PIN: '1234' }, () => {
        const report = buildProductionReadinessReport({
            db: mockDb({ settings: healthySettings() }),
            health: healthyHealth(),
            network: { allow_lan_clients: false, bind_host: '127.0.0.1', port: 3001, https_active: false, warnings: [] },
        });
        const pin = checkById(report, 'pc_admin_pin');
        assert.equal(pin.status, 'error');
        assert.equal(report.ok, false);
        assert.equal(report.status, 'error');
        assert.equal(pin.details.insecureDefault, true);
    });
});

test('tokenless TV mode makes readiness error independently', () => {
    withSecurePin(() => withEnv({
        TGP_TEST_MODE: '1',
        TGP_TOKENLESS_STORE_MODE: '1',
    }, () => {
        const report = buildProductionReadinessReport({
            db: mockDb({ settings: healthySettings() }),
            health: healthyHealth(),
            network: { allow_lan_clients: false, bind_host: '127.0.0.1', port: 3001, https_active: false, warnings: [] },
        });
        const tokenless = checkById(report, 'tokenless_store_mode');
        assert.equal(tokenless.status, 'error');
        assert.equal(report.ok, false);
        assert.equal(report.status, 'error');
        assert.match(tokenless.summary, /tokenless|token/i);
    }));
});

test('authorized devices missing token or purpose make readiness error with pairing remediation', () => {
    withSecurePin(() => {
        const report = buildProductionReadinessReport({
            db: mockDb({
                settings: healthySettings(),
                deviceState: {
                    authorized_devices: 3,
                    missing_token: 1,
                    missing_purpose: 2,
                    missing_token_or_purpose: 2,
                },
            }),
            health: healthyHealth(),
            network: { allow_lan_clients: false, bind_host: '127.0.0.1', port: 3001, https_active: false, warnings: [] },
        });
        const check = checkById(report, 'device_tokens');
        assert.equal(check.status, 'error');
        assert.equal(report.ok, false);
        assert.equal(report.status, 'error');
        assert.match(check.summary, /2 authorized device\(s\).*token or valid purpose/i);
        assert.match(check.summary, /Devices|pair|purpose/i);
        assert.doesNotMatch(JSON.stringify(check), /IP fallback|ip_fallback/i);
        assert.deepEqual(check.details, {
            authorized_devices: 3,
            missing_token: 1,
            missing_purpose: 2,
            missing_token_or_purpose: 2,
        });
    });
});

test('enabled IP fallback setting makes readiness error independently', () => {
    withSecurePin(() => {
        const report = buildProductionReadinessReport({
            db: mockDb({
                settings: healthySettings({ Allow_IP_Fallback: '1' }),
            }),
            health: healthyHealth(),
            network: { allow_lan_clients: false, bind_host: '127.0.0.1', port: 3001, https_active: false, warnings: [] },
        });
        const check = checkById(report, 'ip_fallback');
        assert.equal(check.status, 'error');
        assert.equal(report.ok, false);
        assert.equal(report.status, 'error');
        assert.match(check.summary, /IP fallback/i);
        assert.doesNotMatch(check.summary, /IP fallback is (?:OK|ok|enabled and safe)/i);
    });
});

test('IP fallback check is ok when disabled and never claims fallback authorization is acceptable', () => {
    withSecurePin(() => {
        const report = buildProductionReadinessReport({
            db: mockDb({ settings: healthySettings() }),
            health: healthyHealth(),
            network: { allow_lan_clients: false, bind_host: '127.0.0.1', port: 3001, https_active: false, warnings: [] },
        });
        const check = checkById(report, 'ip_fallback');
        assert.ok(check, 'ip_fallback check must exist');
        assert.equal(check.status, 'ok');
        assert.match(check.summary, /disabled|removed|not (?:enabled|available)|require/i);
        assert.doesNotMatch(JSON.stringify(report.checks), /IP fallback (?:is )?(?:OK|enabled for production)/i);
    });
});

test('LAN enabled without active HTTPS listener makes readiness error with certificate remediation', () => {
    withSecurePin(() => {
        const report = buildProductionReadinessReport({
            db: mockDb({ settings: healthySettings() }),
            health: healthyHealth(),
            network: {
                allow_lan_clients: true,
                bind_host: '0.0.0.0',
                port: 3001,
                https_active: false,
                https_enabled: true,
                lan_addresses: ['192.168.1.10'],
                warnings: ['HTTPS_STARTUP_FAILED: Could not bind HTTPS'],
            },
        });
        const https = checkById(report, 'https_listener');
        assert.equal(https.status, 'error');
        assert.equal(report.ok, false);
        assert.equal(report.status, 'error');
        assert.match(https.summary, /HTTPS|certificate|trust|self-signed/i);
    });
});

test('adapter enumeration warning is visible as warning and does not alone make ok=false', () => {
    withSecurePin(() => {
        const report = buildProductionReadinessReport({
            db: mockDb({ settings: healthySettings() }),
            health: healthyHealth(),
            network: {
                allow_lan_clients: false,
                bind_host: '127.0.0.1',
                port: 3001,
                https_active: false,
                warnings: ['Network adapter enumeration failed: adapter boom'],
            },
        });
        const adapter = checkById(report, 'adapter_enumeration');
        assert.ok(adapter, 'adapter_enumeration check must exist');
        assert.equal(adapter.status, 'warning');
        assert.match(adapter.summary, /adapter enumeration failed/i);
        assert.equal(report.ok, true);
        assert.equal(report.status, 'warning');
        assert.doesNotThrow(() => buildProductionReadinessReport({
            db: mockDb({ settings: healthySettings() }),
            health: healthyHealth(),
            network: {
                allow_lan_clients: false,
                warnings: null,
            },
        }));
    });
});

test('backup check requires verified ok, not header-readable alone', () => {
    withSecurePin(() => {
        const report = buildProductionReadinessReport({
            db: mockDb({ settings: healthySettings() }),
            health: {
                status: 'ok',
                errors: [],
                warnings: [],
                checks: {
                    backups: {
                        ok: false,
                        latest_file: 'tgp_ops_backup_2026-06-21.db',
                        latest_readable: true,
                        latest_verified: false,
                        latest_verify_error: 'file is not a database',
                        latest_age_hours: 1,
                        max_age_hours: 72,
                    },
                },
            },
            network: { allow_lan_clients: false, bind_host: '127.0.0.1', port: 3001, https_active: false, warnings: [] },
        });
        const backup = checkById(report, 'backup_health');
        assert.equal(backup.status, 'warning');
        assert.match(backup.summary, /verified/i);
        assert.doesNotMatch(backup.summary, /readable/i);
    });
});

test('readiness report is ok for local-only healthy setup', () => {
    withSecurePin(() => {
        const report = buildProductionReadinessReport({
            db: mockDb({
                settings: healthySettings({ TV_ACCESS_KEY: 'abc' }),
                ipFallbackCount: 0,
            }),
            health: healthyHealth(),
            network: {
                allow_lan_clients: false,
                bind_host: '127.0.0.1',
                port: 3001,
                https_active: false,
                warnings: [],
            },
            now: new Date('2026-06-21T12:00:00Z'),
        });

        assert.equal(report.status, 'ok');
        assert.equal(report.ok, true);
        assert.equal(report.summary.errors, 0);
        assert.equal(report.summary.warnings, 0);
        assert.equal(checkById(report, 'pc_admin_pin').status, 'ok');
        assert.equal(checkById(report, 'store_instance_id').status, 'ok');
        assert.equal(checkById(report, 'training_mode').status, 'ok');
        assert.equal(checkById(report, 'tokenless_store_mode').status, 'ok');
        assert.equal(checkById(report, 'device_tokens').status, 'ok');
        assert.equal(checkById(report, 'ip_fallback').status, 'ok');
        assert.equal(report.checks.some((c) => c.id === 'tv_access_key'), false);
    });
});

test('readiness aggregation treats error as blocking and never ignores fail as a fourth state', () => {
    withSecurePin(() => {
        const report = buildProductionReadinessReport({
            db: mockDb({
                settings: healthySettings({ Training_Mode_Enabled: '1' }),
            }),
            health: healthyHealth(),
            network: { allow_lan_clients: false, bind_host: '127.0.0.1', port: 3001, https_active: false, warnings: [] },
        });
        assert.ok(['ok', 'warning', 'error'].includes(report.status));
        assert.equal(report.checks.every((c) => ['ok', 'warning', 'error'].includes(c.status)), true);
        assert.equal(report.checks.some((c) => c.status === 'fail'), false);
        assert.equal(report.ok, report.status !== 'error');
    });
});
