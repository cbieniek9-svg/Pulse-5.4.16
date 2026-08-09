#!/usr/bin/env node
'use strict';

/** Fail unless this process is the packaged Electron-as-Node SQLite runtime. */
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const pkg = require(path.join(appRoot, 'package.json'));
const expectedElectron = pkg.devDependencies?.electron;
const actualElectron = process.versions.electron;

if (!actualElectron) {
    throw new Error('Release verification is running under system Node, not Electron-as-Node. Run npm install before preparing a store package.');
}
if (!expectedElectron || actualElectron !== expectedElectron) {
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
