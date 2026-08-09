'use strict';

const { APP_VERSION } = require('../app-version.cjs');
const { isTokenlessStoreModeEnabled } = require('./poc-access.cjs');
const { inspectPcAdminPin } = require('./pc-admin-pin.cjs');
const { getStoreMeta } = require('../constants/store-meta.cjs');
const {
    getDeployBootFingerprint,
    inspectDeployFidelity,
} = require('./deploy-fidelity.cjs');

function settingBool(settings, key, fallback = false) {
    const value = settings?.[key];
    if (value == null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
    return fallback;
}

function inspectAuthorizedDeviceCredentials(db) {
    try {
        const row = db.get(`
            SELECT
                COUNT(*) AS authorized_devices,
                COALESCE(SUM(
                    CASE WHEN device_token_hash IS NULL OR device_token_hash = '' THEN 1 ELSE 0 END
                ), 0) AS missing_token,
                COALESCE(SUM(
                    CASE WHEN LOWER(TRIM(COALESCE(device_purpose, '')))
                        NOT IN ('tv', 'cs_desk', 'receiving', 'markdown') THEN 1 ELSE 0 END
                ), 0) AS missing_purpose,
                COALESCE(SUM(
                    CASE WHEN device_token_hash IS NULL OR device_token_hash = ''
                        OR LOWER(TRIM(COALESCE(device_purpose, '')))
                            NOT IN ('tv', 'cs_desk', 'receiving', 'markdown')
                        THEN 1 ELSE 0 END
                ), 0) AS missing_token_or_purpose
            FROM trusted_devices
            WHERE status='Authorized'
        `) || {};
        return {
            authorized_devices: Number(row.authorized_devices || 0),
            missing_token: Number(row.missing_token || 0),
            missing_purpose: Number(row.missing_purpose || 0),
            missing_token_or_purpose: Number(row.missing_token_or_purpose || 0),
        };
    } catch (_) {
        return null;
    }
}

function inspectTrainingAccess(db, settings) {
    const settingEnabled = settingBool(settings, 'Training_Mode_Enabled', false);
    let staffActive = 0;
    let staffAppAccess = 0;
    let staffRisk = 0;
    try {
        const row = db?.get?.(`
            SELECT
                COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS active,
                COALESCE(SUM(CASE WHEN app_access = 1 THEN 1 ELSE 0 END), 0) AS app_access
            FROM staff
            WHERE UPPER(TRIM(name)) = 'TRAINING MODE'
              AND (active = 1 OR app_access = 1)
        `) || {};
        staffRisk = Number(row.n || 0);
        staffActive = Number(row.active || 0);
        staffAppAccess = Number(row.app_access || 0);
    } catch (_) {
        // Staff table may be unavailable in lightweight mocks; setting flag still applies.
    }
    return {
        settingEnabled,
        staffRisk,
        staffActive,
        staffAppAccess,
        blocked: settingEnabled || staffRisk > 0,
    };
}

function isIpFallbackEnabled(settings, network) {
    if (network?.allow_ip_fallback === true) return true;
    return (
        settingBool(settings, 'Allow_IP_Fallback', false)
        || settingBool(settings, 'Allow_IP_Device_Fallback', false)
        || settingBool(settings, 'Trusted_Device_IP_Fallback', false)
    );
}

function listNetworkWarnings(network) {
    try {
        const warnings = network?.warnings;
        if (!Array.isArray(warnings)) return [];
        return warnings.map((w) => String(w || '')).filter(Boolean);
    } catch (_) {
        return [];
    }
}

function addCheck(checks, id, label, status, summary, details = {}) {
    checks.push({
        id,
        label,
        status,
        summary,
        details,
    });
}

function buildProductionReadinessReport({
    db,
    health = null,
    network = null,
    now = new Date(),
    deployFidelity = null,
} = {}) {
    const settings = db?.getSettings ? db.getSettings() : {};
    const checks = [];

    if (!health) {
        addCheck(checks, 'database_health', 'Database health', 'warning', 'Database health has not been checked yet.');
    } else if (health.status === 'error') {
        addCheck(checks, 'database_health', 'Database health', 'error', (health.errors || []).join(' ') || 'Database health check failed.', { errors: health.errors || [] });
    } else if (health.status === 'warning') {
        addCheck(checks, 'database_health', 'Database health', 'warning', (health.warnings || []).join(' ') || 'Database health warnings found.', { warnings: health.warnings || [] });
    } else {
        addCheck(checks, 'database_health', 'Database health', 'ok', 'Database quick checks are passing.');
    }

    const backup = health?.checks?.backups || null;
    if (!backup) {
        addCheck(checks, 'backup_health', 'Backups', 'warning', 'Backup health has not been checked yet.');
    } else if (!backup.ok || backup.latest_verified === false) {
        addCheck(checks, 'backup_health', 'Backups', 'warning', 'No verified generated backup is available.', backup);
    } else if (Number(backup.latest_age_hours || 0) > Number(backup.max_age_hours || 72)) {
        addCheck(checks, 'backup_health', 'Backups', 'warning', `Latest verified backup is ${Math.round(Number(backup.latest_age_hours))} hours old.`, backup);
    } else {
        addCheck(checks, 'backup_health', 'Backups', 'ok', `Latest backup is verified: ${backup.latest_file || 'generated backup'}.`, backup);
    }

    if (network?.allow_lan_clients) {
        addCheck(
            checks,
            'lan_exposure',
            'LAN exposure',
            'warning',
            'LAN clients are enabled. This is correct for TV/mobile devices, but the store Wi-Fi/LAN must stay trusted.',
            {
                bind_host: network.bind_host,
                port: network.port,
                public_base_url: network.public_base_url,
                lan_addresses: network.lan_addresses || [],
            },
        );
    } else if (network) {
        addCheck(checks, 'lan_exposure', 'LAN exposure', 'ok', 'LAN clients are disabled; only this PC can connect.', network);
    } else {
        addCheck(checks, 'lan_exposure', 'LAN exposure', 'warning', 'Network exposure details are unavailable.');
    }

    if (network?.allow_lan_clients) {
        if (network.https_active) {
            addCheck(
                checks,
                'https_listener',
                'HTTPS LAN listener',
                'ok',
                'HTTPS is active for LAN clients. On phones, accept the self-signed certificate warning once (Advanced → Proceed), then reopen the HTTPS pairing URL.',
                {
                    https_active: true,
                    https_port: network.https_port || null,
                    public_https_base_url: network.public_https_base_url || '',
                },
            );
        } else {
            addCheck(
                checks,
                'https_listener',
                'HTTPS LAN listener',
                'error',
                'LAN is enabled but HTTPS is not active (HTTPS_STARTUP_FAILED). Repair certificate/bind setup, restart Pulse, then have devices trust the self-signed certificate once before pairing.',
                {
                    https_active: false,
                    https_enabled: !!network.https_enabled,
                    https_port: network.https_port || null,
                    lan_ready: !!network.lan_ready,
                },
            );
        }
    } else if (network) {
        addCheck(
            checks,
            'https_listener',
            'HTTPS LAN listener',
            'ok',
            'LAN clients are disabled; an active HTTPS LAN listener is not required.',
            { https_active: !!network.https_active },
        );
    } else {
        addCheck(checks, 'https_listener', 'HTTPS LAN listener', 'warning', 'HTTPS listener status is unavailable.');
    }

    const networkWarnings = listNetworkWarnings(network);
    const adapterWarning = networkWarnings.find((w) => /adapter enumeration failed/i.test(w));
    if (adapterWarning) {
        addCheck(
            checks,
            'adapter_enumeration',
            'Network adapters',
            'warning',
            adapterWarning,
            { warnings: networkWarnings },
        );
    } else if (network) {
        addCheck(
            checks,
            'adapter_enumeration',
            'Network adapters',
            'ok',
            'Network adapter enumeration completed without errors.',
            { warnings: networkWarnings },
        );
    } else {
        addCheck(checks, 'adapter_enumeration', 'Network adapters', 'warning', 'Network adapter details are unavailable.');
    }

    const training = inspectTrainingAccess(db, settings);
    if (training.blocked) {
        const parts = [];
        if (training.settingEnabled) parts.push('Training_Mode_Enabled=1');
        if (training.staffRisk > 0) {
            parts.push(
                `TRAINING MODE staff still has active=${training.staffActive > 0 ? 1 : 0} or app_access=${training.staffAppAccess > 0 ? 1 : 0}`,
            );
        }
        addCheck(
            checks,
            'training_mode',
            'Training mode',
            'error',
            `Training access is still enabled (${parts.join('; ')}). Disable training mode and revoke the TRAINING MODE staff row (active=0, app_access=0) before going live.`,
            training,
        );
    } else {
        addCheck(
            checks,
            'training_mode',
            'Training mode',
            'ok',
            'Training mode is disabled and no TRAINING MODE staff row has active or app_access enabled.',
            training,
        );
    }

    const tokenlessStoreMode = isTokenlessStoreModeEnabled(db);
    addCheck(
        checks,
        'tokenless_store_mode',
        'Tokenless store mode',
        tokenlessStoreMode ? 'error' : 'ok',
        tokenlessStoreMode
            ? 'Tokenless TV mode is enabled. Disable TGP_TOKENLESS_STORE_MODE / test overrides and require purpose-scoped device tokens before production use.'
            : 'TV/display clients require a valid purpose-scoped device token.',
        { tokenless_store_mode: tokenlessStoreMode },
    );

    const deviceCredentials = inspectAuthorizedDeviceCredentials(db);
    if (deviceCredentials == null) {
        addCheck(checks, 'device_tokens', 'Trusted device tokens', 'warning', 'Could not inspect trusted device token state.');
    } else if (deviceCredentials.missing_token_or_purpose > 0) {
        addCheck(
            checks,
            'device_tokens',
            'Trusted device tokens',
            'error',
            `${deviceCredentials.missing_token_or_purpose} authorized device(s) are missing a required token or valid purpose. Pair each device under Settings → Devices with a purpose and token (one-time HTTPS pairing URL).`,
            deviceCredentials,
        );
    } else {
        addCheck(
            checks,
            'device_tokens',
            'Trusted device tokens',
            'ok',
            'Authorized devices have a valid purpose and token, or no authorized devices exist.',
            deviceCredentials,
        );
    }

    if (isIpFallbackEnabled(settings, network)) {
        addCheck(
            checks,
            'ip_fallback',
            'IP fallback authorization',
            'error',
            'IP fallback authorization is enabled. Disable Allow_IP_Fallback (and related flags); devices must use purpose-bound tokens from Settings → Devices.',
            { allow_ip_fallback: true },
        );
    } else {
        addCheck(
            checks,
            'ip_fallback',
            'IP fallback authorization',
            'ok',
            'IP fallback authorization is disabled; devices require purpose-bound tokens.',
            { allow_ip_fallback: false },
        );
    }

    const pinInfo = inspectPcAdminPin({ db });
    if (pinInfo.secure === false) {
        addCheck(
            checks,
            'pc_admin_pin',
            'PC_ADMIN bootstrap PIN',
            'error',
            'PC_ADMIN bootstrap credentials are insecure or unavailable (legacy/default 1234, invalid file, or manager check failed). Configure a secure 8-digit PIN via PC_ADMIN_PIN or pc-admin-pin.txt before deploying.',
            {
                source: pinInfo.source,
                configured: pinInfo.configured,
                secure: false,
                insecureDefault: pinInfo.insecureDefault,
            },
        );
    } else if (pinInfo.source === 'pending_generate') {
        addCheck(
            checks,
            'pc_admin_pin',
            'PC_ADMIN bootstrap PIN',
            'ok',
            'Fresh install will mint pc-admin-pin.txt on first PC_ADMIN login if env is unset.',
            pinInfo,
        );
    } else {
        addCheck(
            checks,
            'pc_admin_pin',
            'PC_ADMIN bootstrap PIN',
            'ok',
            pinInfo.source === 'env'
                ? 'PC_ADMIN_PIN is set via environment.'
                : 'PC_ADMIN PIN is loaded from pc-admin-pin.txt.',
            { source: pinInfo.source },
        );
    }

    const store = getStoreMeta(settings);
    addCheck(
        checks,
        'store_instance_id',
        'Store instance id',
        store.instanceId ? 'ok' : 'warning',
        store.instanceId
            ? `Store_Instance_Id is set (${store.code}).`
            : 'Store_Instance_Id is missing — re-open the app so migration 029 can mint it.',
        { store_code: store.code, instance_id: store.instanceId || null },
    );

    const deploy = deployFidelity || inspectDeployFidelity(getDeployBootFingerprint());
    if (!deploy.ui_exists) {
        addCheck(
            checks,
            'deploy_fidelity',
            'Deploy / process fidelity',
            'warning',
            deploy.summary,
            deploy,
        );
    } else if (deploy.restart_required) {
        addCheck(
            checks,
            'deploy_fidelity',
            'Deploy / process fidelity',
            'warning',
            deploy.summary,
            deploy,
        );
    } else {
        addCheck(
            checks,
            'deploy_fidelity',
            'Deploy / process fidelity',
            'ok',
            deploy.summary,
            deploy,
        );
    }

    // Normalize legacy 'fail' into 'error' so aggregation never ignores blockers.
    checks.forEach((c) => {
        if (c && c.status === 'fail') c.status = 'error';
    });
    const status = checks.some((c) => c.status === 'error') ? 'error'
        : checks.some((c) => c.status === 'warning') ? 'warning'
            : 'ok';

    return {
        ok: status !== 'error',
        status,
        checked_at: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
        app_version: APP_VERSION,
        restart_required: !!deploy.restart_required,
        deploy,
        checks,
        summary: {
            ok: checks.filter((c) => c.status === 'ok').length,
            warnings: checks.filter((c) => c.status === 'warning').length,
            errors: checks.filter((c) => c.status === 'error').length,
        },
    };
}

module.exports = {
    buildProductionReadinessReport,
    settingBool,
};
