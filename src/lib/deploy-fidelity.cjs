'use strict';

const fs = require('fs');
const path = require('path');
const { APP_VERSION } = require('../app-version.cjs');

/** @type {ReturnType<typeof captureDeployBootFingerprint>|null} */
let bootFingerprint = null;

/**
 * Capture on-disk UI/version fingerprints at process boot so /api/ready can
 * detect "files copied, service not restarted" skew.
 */
function captureDeployBootFingerprint(appRoot) {
    const root = appRoot || path.resolve(__dirname, '..', '..');
    const uiIndex = path.join(root, 'dist', 'ui', 'index.html');
    let uiMtimeMs = null;
    let uiSize = null;
    try {
        const st = fs.statSync(uiIndex);
        uiMtimeMs = st.mtimeMs;
        uiSize = st.size;
    } catch (_) { /* UI may be missing until build:ui */ }

    bootFingerprint = {
        appRoot: root,
        process_version: APP_VERSION,
        boot_at: new Date().toISOString(),
        boot_uptime_origin_ms: Date.now(),
        ui_index_path: uiIndex,
        ui_index_mtime_ms_at_boot: uiMtimeMs,
        ui_index_size_at_boot: uiSize,
    };
    return bootFingerprint;
}

function getDeployBootFingerprint() {
    return bootFingerprint;
}

function readDiskAppVersion(appRoot) {
    try {
        const raw = fs.readFileSync(path.join(appRoot, 'src', 'app-version.cjs'), 'utf8');
        const m = raw.match(/APP_VERSION:\s*['"]([^'"]+)['"]/);
        return m ? m[1] : null;
    } catch (_) {
        return null;
    }
}

function inspectDeployFidelity(bootFingerprint) {
    const boot = bootFingerprint || {};
    const appRoot = boot.appRoot || path.resolve(__dirname, '..', '..');
    const diskVersion = readDiskAppVersion(appRoot);
    const versionMismatch = Boolean(diskVersion && diskVersion !== APP_VERSION);

    let uiMtimeMs = null;
    let uiSize = null;
    let uiExists = false;
    try {
        const st = fs.statSync(path.join(appRoot, 'dist', 'ui', 'index.html'));
        uiExists = true;
        uiMtimeMs = st.mtimeMs;
        uiSize = st.size;
    } catch (_) { /* missing */ }

    const bootMtime = boot.ui_index_mtime_ms_at_boot;
    const bootSize = boot.ui_index_size_at_boot;
    const uiNewerThanBoot = Boolean(
        uiExists
        && bootMtime != null
        && (uiMtimeMs > bootMtime + 1500 || (uiSize != null && bootSize != null && uiSize !== bootSize)),
    );

    const restartRequired = versionMismatch || uiNewerThanBoot;
    let summary = 'Process matches on-disk app version and UI build.';
    if (!uiExists) summary = 'React UI build (dist/ui/index.html) is missing.';
    else if (versionMismatch && uiNewerThanBoot) {
        summary = `Restart required — disk version ${diskVersion} and UI build are newer than running process ${APP_VERSION}.`;
    } else if (versionMismatch) {
        summary = `Restart required — disk app-version is ${diskVersion} but process is ${APP_VERSION}.`;
    } else if (uiNewerThanBoot) {
        summary = 'Restart required — dist/ui was rebuilt after this process started.';
    }

    return {
        ok: !restartRequired && uiExists,
        restart_required: restartRequired,
        summary,
        process_version: APP_VERSION,
        disk_version: diskVersion,
        version_mismatch: versionMismatch,
        ui_exists: uiExists,
        ui_index_mtime_ms: uiMtimeMs,
        ui_index_mtime_ms_at_boot: bootMtime,
        ui_newer_than_boot: uiNewerThanBoot,
        boot_at: boot.boot_at || null,
        uptime_sec: process.uptime(),
    };
}

module.exports = {
    captureDeployBootFingerprint,
    getDeployBootFingerprint,
    inspectDeployFidelity,
    readDiskAppVersion,
};
