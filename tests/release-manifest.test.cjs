'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const { APP_VERSION } = require('../src/app-version.cjs');
const { buildReleaseManifest, latestMigrationVersion, readStaticReleaseManifest } = require('../src/lib/release-manifest.cjs');

test('static release manifest is present and matches app version', () => {
    const manifestPath = path.join(appRoot, 'release-manifest.json');
    assert.equal(fs.existsSync(manifestPath), true);
    const manifest = readStaticReleaseManifest();
    assert.equal(manifest.appVersion, APP_VERSION);
    assert.ok(Array.isArray(manifest.patches));
    assert.ok(manifest.patches.includes('poc-release-confidence'));
    assert.ok(manifest.verificationScripts.includes('verify:release'));
});

test('release manifest reports latest migration and db schema status', () => {
    const latest = latestMigrationVersion();
    assert.equal(latest >= 17, true);

    const manifest = buildReleaseManifest({
        db: {
            get(sql) {
                if (/schema_version/i.test(sql)) return { version: latest };
                return null;
            },
        },
    });

    assert.equal(manifest.appVersion, APP_VERSION);
    assert.equal(manifest.latestMigration, latest);
    assert.equal(manifest.databaseSchemaVersion, latest);
    assert.equal(manifest.migrationsCurrent, true);
});
