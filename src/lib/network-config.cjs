'use strict';

const { listPrivateIpv4 } = require('./safe-network-interfaces.cjs');

const DEFAULT_PORT = 3001;
const DEFAULT_BIND_HOST = '0.0.0.0';
const LOCAL_ONLY_HOST = '127.0.0.1';

function toBool(value, fallback = true) {
    if (value == null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
    return fallback;
}

function parsePort(value, fallback = DEFAULT_PORT) {
    const n = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback;
    return n;
}

function normalizeBindHost(value, allowLanClients) {
    if (!allowLanClients) return LOCAL_ONLY_HOST;
    const raw = String(value || DEFAULT_BIND_HOST).trim();
    if (!raw || raw === LOCAL_ONLY_HOST || raw === 'localhost') return LOCAL_ONLY_HOST;
    if (raw === '0.0.0.0' || raw === '::') return raw;
    // Allow a specific LAN interface address, but reject shell-ish/surprising values.
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw)) return raw;
    return DEFAULT_BIND_HOST;
}

function getPrivateInterfaceAddresses(opts = {}) {
    return listPrivateIpv4(opts).addresses;
}

/** Prefer typical store Wi‑Fi (192.168) over Hyper-V/WSL 172.x adapters. */
function pickPrimaryLanAddress(addresses = []) {
    const list = Array.isArray(addresses) ? addresses : [];
    return (
        list.find((a) => /^192\.168\./.test(a))
        || list.find((a) => /^10\./.test(a))
        || list.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a))
        || list[0]
        || ''
    );
}

function isPrivateHostname(host) {
    return (
        /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)
        || /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
        || /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
    );
}

function isLoopbackHostname(host) {
    const h = String(host || '').replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * @param {object} [settings]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ networkInterfaces?: () => object }} [opts]
 */
function buildNetworkConfig(settings = {}, env = process.env, opts = {}) {
    const envAllow = env.TGP_ALLOW_LAN_CLIENTS ?? env.TGP_ALLOW_LAN;
    const allowLanClients = toBool(envAllow ?? settings.Allow_LAN_Clients, true);
    const configuredHost = env.TGP_BIND_HOST ?? settings.LAN_Bind_Host ?? DEFAULT_BIND_HOST;
    const httpsBindHost = normalizeBindHost(configuredHost, allowLanClients);
    const httpBindHost = LOCAL_ONLY_HOST;
    const port = parsePort(env.PORT ?? env.TGP_PORT ?? settings.LAN_Port, DEFAULT_PORT);
    // HTTPS for camera / secure-context portals (phones on store Wi‑Fi).
    const httpsPort = parsePort(env.TGP_HTTPS_PORT ?? settings.LAN_Https_Port, port === 3001 ? 3443 : port + 442);
    const httpsEnabled = toBool(env.TGP_HTTPS ?? settings.LAN_Https_Enabled, true);

    const enumerated = listPrivateIpv4({ networkInterfaces: opts.networkInterfaces });
    const lanAddresses = enumerated.addresses;
    const primaryLan = pickPrimaryLanAddress(lanAddresses);
    const hasLanAddresses = lanAddresses.length > 0;

    // Electron/desktop management stays on loopback HTTP. Store-network access is HTTPS only.
    const publicBaseUrl = `http://127.0.0.1:${port}`;
    const publicHttpsBaseUrl = httpsEnabled
        ? (
            allowLanClients && httpsBindHost !== LOCAL_ONLY_HOST && hasLanAddresses && primaryLan
                ? `https://${primaryLan}:${httpsPort}`
                : `https://127.0.0.1:${httpsPort}`
        )
        : '';

    const warnings = [];
    if (enumerated.warning) warnings.push(enumerated.warning);
    if (allowLanClients && (httpsBindHost === '0.0.0.0' || httpsBindHost === '::')) {
        warnings.push('Server is reachable from other devices on this store network over HTTPS.');
    }
    if (!allowLanClients) {
        warnings.push('LAN clients are disabled; only this PC can connect until the app is restarted with LAN enabled.');
    }
    if (httpsEnabled) {
        warnings.push(`HTTPS (camera) on port ${httpsPort} — accept the self-signed warning once on phones.`);
    }

    return {
        allow_lan_clients: allowLanClients,
        http_bind_host: httpBindHost,
        https_bind_host: httpsBindHost,
        // Legacy alias: configured LAN/HTTPS bind host (not the HTTP loopback listener).
        bind_host: httpsBindHost,
        port,
        https_enabled: httpsEnabled,
        https_port: httpsPort,
        https_active: false,
        lan_ready: false,
        lan_addresses: lanAddresses,
        public_base_url: publicBaseUrl,
        public_https_base_url: publicHttpsBaseUrl,
        warnings,
    };
}

function isAllowedCorsOrigin(origin, networkConfig) {
    // Non-CORS clients omit Origin; opaque "null" must never be allowlisted.
    if (origin == null || origin === '') return true;
    if (origin === 'null') return false;
    let parsed;
    try { parsed = new URL(origin); } catch (_) { return false; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
    const port = parsed.port || defaultPort;
    const host = parsed.hostname;

    // Loopback HTTP origin for the Electron desktop shell.
    if (parsed.protocol === 'http:') {
        if (!isLoopbackHostname(host)) return false;
        return port === String(networkConfig.port);
    }

    // Private HTTPS origins only (store-network clients).
    const expectedHttpsPort = String(networkConfig.https_port || '');
    if (!expectedHttpsPort || port !== expectedHttpsPort) return false;
    if (isLoopbackHostname(host)) return true;
    if (!networkConfig.allow_lan_clients) return false;
    return isPrivateHostname(host) || (networkConfig.lan_addresses || []).includes(host);
}

module.exports = {
    DEFAULT_PORT,
    DEFAULT_BIND_HOST,
    LOCAL_ONLY_HOST,
    toBool,
    parsePort,
    normalizeBindHost,
    buildNetworkConfig,
    getPrivateInterfaceAddresses,
    pickPrimaryLanAddress,
    isAllowedCorsOrigin,
};
