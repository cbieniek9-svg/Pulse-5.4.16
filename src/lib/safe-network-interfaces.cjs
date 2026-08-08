'use strict';

const os = require('os');

function isPrivateIpv4(addr) {
    return (
        /^10\./.test(addr)
        || /^192\.168\./.test(addr)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(addr)
    );
}

function preferenceRank(addr) {
    if (/^192\.168\./.test(addr)) return 0;
    if (/^10\./.test(addr)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 2;
    return 9;
}

function normalizePrivateAddresses(interfaces) {
    const addresses = [];
    for (const entries of Object.values(interfaces || {})) {
        for (const entry of entries || []) {
            if (!entry || entry.internal) continue;
            if (entry.family !== 'IPv4' && entry.family !== 4) continue;
            const addr = String(entry.address || '').trim();
            if (!addr || !isPrivateIpv4(addr)) continue;
            addresses.push(addr);
        }
    }
    const unique = [...new Set(addresses)];
    unique.sort((a, b) => {
        const rankDiff = preferenceRank(a) - preferenceRank(b);
        if (rankDiff !== 0) return rankDiff;
        return a.localeCompare(b);
    });
    return unique;
}

/**
 * Exception-safe private IPv4 enumeration for store LAN discovery.
 * Prefer 192.168, then 10, then RFC1918 172.16-31. Never throws.
 *
 * @param {{ networkInterfaces?: () => object }} [opts]
 * @returns {{ addresses: string[], warning: string }}
 */
function listPrivateIpv4({ networkInterfaces = os.networkInterfaces } = {}) {
    try {
        const raw = typeof networkInterfaces === 'function' ? networkInterfaces() : {};
        return { addresses: normalizePrivateAddresses(raw), warning: '' };
    } catch (error) {
        return {
            addresses: [],
            warning: `Network adapter enumeration failed: ${error && error.message ? error.message : String(error)}`,
        };
    }
}

module.exports = {
    listPrivateIpv4,
    normalizePrivateAddresses,
    isPrivateIpv4,
    preferenceRank,
};
