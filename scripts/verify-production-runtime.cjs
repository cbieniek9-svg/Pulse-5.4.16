#!/usr/bin/env node
'use strict';

/** Fail unless this process is the packaged Electron-as-Node SQLite runtime. */
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const pkg = require(path.join(appRoot, 'package.json'));
const expectedElectron = pkg.devDependencies?.electron;
const actualElectron = process.versions.electron;

/** Minimal semver range check (^ / ~ / exact). Avoids adding a semver dependency. */
function versionSatisfies(actual, range) {
    if (!actual || !range) return false;
    const want = String(range).trim();
    const have = String(actual).trim();
    try {
        // Prefer nested/hoisted semver if npm already installed it transitively.
        // eslint-disable-next-line import/no-extraneous-dependencies
        const semver = require('semver');
        if (semver && typeof semver.satisfies === 'function') {
            return semver.satisfies(have, want, { includePrerelease: true });
        }
    } catch (_) { /* fall through */ }

    const parse = (v) => {
        const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
        if (!m) return null;
        return { major: +m[1], minor: +m[2], patch: +m[3] };
    };
    const cmp = (a, b) => (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
    const a = parse(have);
    if (!a) return false;

    if (want.startsWith('^')) {
        const b = parse(want.slice(1));
        if (!b) return false;
        return a.major === b.major && cmp(a, b) >= 0;
    }
    if (want.startsWith('~')) {
        const b = parse(want.slice(1));
        if (!b) return false;
        return a.major === b.major && a.minor === b.minor && cmp(a, b) >= 0;
    }
    const b = parse(want);
    if (!b) return have === want;
    return cmp(a, b) === 0;
}

if (!actualElectron) {
    throw new Error('Release verification is running under system Node, not Electron-as-Node. Run npm install before preparing a store package.');
}
if (!expectedElectron || !versionSatisfies(actualElectron, expectedElectron)) {
    throw new Error(`Electron runtime mismatch: running ${actualElectron}, package requires ${expectedElectron || 'a pinned version'}.`);
}

const abiFile = path.join(appRoot, 'node_modules', 'electron', 'abi_version');
const expectedAbi = fs.readFileSync(abiFile, 'utf8').trim();
if (String(process.versions.modules) !== expectedAbi) {
    throw new Error(`Electron ABI mismatch: running ${process.versions.modules}, package expects ${expectedAbi}.`);
}

const Database = require('better-sqlite3');
const db = new Database(':memory:');
try {
    db.prepare('SELECT 1 AS ok').get();
} finally {
    db.close();
}

console.log(`OK production runtime Electron ${actualElectron}, ABI ${expectedAbi}, better-sqlite3 loadable`);
