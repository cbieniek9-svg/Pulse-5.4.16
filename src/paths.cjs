'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Runtime data root for this Command Center instance (single-store today).
 * Override with TGP_DATA_DIR for portable installs or future per-store directories.
 * Multi-store rollout: each host (or container) sets TGP_DATA_DIR → one DB per store.
 */
function getDataRoot() {
    const override = process.env.TGP_DATA_DIR;
    if (override && String(override).trim()) {
        return path.resolve(String(override).trim());
    }
    return path.dirname(process.execPath);
}

function getDbPath() {
    return path.join(getDataRoot(), 'tgp_ops.db');
}

/** Isolated inventory-count SQLite (not the main ops DB). */
function getPulseInventoryDbPath() {
    return path.join(getDataRoot(), 'data', 'pulse_inventory.db');
}

function getBackupsDir() {
    return path.join(getDataRoot(), 'backups');
}

function getLogPath() {
    return path.join(getDataRoot(), 'tgp_error.log');
}

function ensureBackupsDir() {
    const dir = getBackupsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function resolveBackupPath(filename) {
    const safe = String(filename || '').replace(/[^a-zA-Z0-9._-]/g, '');
    return path.join(getBackupsDir(), safe);
}

module.exports = {
    getDataRoot,
    getDbPath,
    getPulseInventoryDbPath,
    getBackupsDir,
    getLogPath,
    ensureBackupsDir,
    resolveBackupPath,
};
