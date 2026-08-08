'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    captureDeployBootFingerprint,
    inspectDeployFidelity,
} = require('../src/lib/deploy-fidelity.cjs');
const { APP_VERSION } = require('../src/app-version.cjs');

test('inspectDeployFidelity matches boot fingerprint when unchanged', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-deploy-'));
    try {
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.mkdirSync(path.join(root, 'dist', 'ui'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'src', 'app-version.cjs'),
            `module.exports = { APP_VERSION: '${APP_VERSION}' };\n`,
        );
        fs.writeFileSync(path.join(root, 'dist', 'ui', 'index.html'), '<html>boot</html>');
        const boot = captureDeployBootFingerprint(root);
        const report = inspectDeployFidelity(boot);
        assert.equal(report.restart_required, false);
        assert.equal(report.version_mismatch, false);
        assert.equal(report.ui_newer_than_boot, false);
        assert.equal(report.ok, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('inspectDeployFidelity flags UI rebuilt after boot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-deploy-'));
    try {
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.mkdirSync(path.join(root, 'dist', 'ui'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'src', 'app-version.cjs'),
            `module.exports = { APP_VERSION: '${APP_VERSION}' };\n`,
        );
        const ui = path.join(root, 'dist', 'ui', 'index.html');
        fs.writeFileSync(ui, '<html>boot</html>');
        const boot = captureDeployBootFingerprint(root);
        // Ensure mtime advances past the 1500ms tolerance.
        const newer = new Date(Date.now() + 5000);
        fs.writeFileSync(ui, '<html>rebuilt after boot</html>');
        fs.utimesSync(ui, newer, newer);
        const report = inspectDeployFidelity(boot);
        assert.equal(report.restart_required, true);
        assert.equal(report.ui_newer_than_boot, true);
        assert.match(report.summary, /Restart required/i);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
