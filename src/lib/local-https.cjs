'use strict';

const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');
const { getDataRoot } = require('../paths.cjs');
const { listPrivateIpv4, isPrivateIpv4 } = require('./safe-network-interfaces.cjs');

function listLanIpv4(opts = {}) {
    return listPrivateIpv4(opts).addresses;
}

function certPaths() {
    const dir = path.join(getDataRoot(), 'certs');
    return {
        dir,
        key: path.join(dir, 'tgp-https-key.pem'),
        cert: path.join(dir, 'tgp-https-cert.pem'),
        meta: path.join(dir, 'tgp-https-meta.json'),
    };
}

function assertWritableDataRoot(paths) {
    const dataRoot = getDataRoot();
    try {
        fs.mkdirSync(paths.dir, { recursive: true });
        const probe = path.join(paths.dir, `.write-probe-${process.pid}`);
        fs.writeFileSync(probe, 'ok', { encoding: 'utf8' });
        fs.unlinkSync(probe);
    } catch (error) {
        const err = new Error(
            `HTTPS certificate data root is not writable (${dataRoot}): ${error.message}`,
        );
        err.code = 'HTTPS_DATA_ROOT_UNWRITABLE';
        throw err;
    }
}

/** Safe store-local DNS labels for certificate SANs (no spaces / shell metacharacters). */
function isSafeDnsHostname(host) {
    const h = String(host || '').trim().toLowerCase();
    if (!h || h.length > 253) return false;
    if (h === 'localhost' || h === 'tgp.local') return true;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(h)) {
        return false;
    }
    // Keep SANs store-local: single-label or *.local only.
    return !h.includes('.') || h.endsWith('.local');
}

function buildAltNames(extraHosts = [], opts = {}) {
    const altNames = [
        { type: 2, value: 'localhost' },
        { type: 2, value: 'tgp.local' },
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: '::1' },
    ];
    for (const ip of listLanIpv4(opts)) {
        altNames.push({ type: 7, ip });
    }
    for (const host of extraHosts) {
        const h = String(host || '').trim();
        if (!h) continue;
        if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h)) {
            if (isPrivateIpv4(h)) altNames.push({ type: 7, ip: h });
            continue;
        }
        if (h === '::1') {
            altNames.push({ type: 7, ip: h });
            continue;
        }
        if (isSafeDnsHostname(h)) altNames.push({ type: 2, value: h.toLowerCase() });
    }
    return altNames;
}

/**
 * Ensure a store-local TLS cert exists (self-signed) covering localhost + LAN IPs.
 * Phones must accept the warning once; then getUserMedia / live camera works.
 */
function ensureLocalHttpsCredentials(opts = {}) {
    const paths = certPaths();
    assertWritableDataRoot(paths);

    const lanIps = listLanIpv4(opts);
    let reuse = false;
    if (fs.existsSync(paths.key) && fs.existsSync(paths.cert) && fs.existsSync(paths.meta)) {
        try {
            const meta = JSON.parse(fs.readFileSync(paths.meta, 'utf8'));
            const prev = Array.isArray(meta.lanIps) ? meta.lanIps.slice().sort().join(',') : '';
            const now = lanIps.slice().sort().join(',');
            // Regenerate when LAN IPs change so new store Wi‑Fi addresses are covered.
            reuse = prev === now && Date.parse(meta.expiresAt || 0) > Date.now() + 7 * 86400000;
        } catch (_) {
            reuse = false;
        }
    }

    if (reuse) {
        return {
            key: fs.readFileSync(paths.key),
            cert: fs.readFileSync(paths.cert),
            lanIps,
            generated: false,
            paths,
        };
    }

    const attrs = [
        { name: 'commonName', value: 'TGP Command Center' },
        { name: 'organizationName', value: 'TGP Store Local' },
    ];
    const pems = selfsigned.generate(attrs, {
        days: 825,
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
            { name: 'basicConstraints', cA: false },
            {
                name: 'keyUsage',
                digitalSignature: true,
                keyEncipherment: true,
            },
            {
                name: 'extKeyUsage',
                serverAuth: true,
            },
            {
                name: 'subjectAltName',
                altNames: buildAltNames(opts.extraHosts, opts),
            },
        ],
    });

    fs.writeFileSync(paths.key, pems.private, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(paths.cert, pems.cert, { encoding: 'utf8' });
    fs.writeFileSync(paths.meta, JSON.stringify({
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 825 * 86400000).toISOString(),
        lanIps,
    }, null, 2), 'utf8');

    return {
        key: pems.private,
        cert: pems.cert,
        lanIps,
        generated: true,
        paths,
    };
}

module.exports = {
    ensureLocalHttpsCredentials,
    listLanIpv4,
    certPaths,
    buildAltNames,
    isSafeDnsHostname,
};
