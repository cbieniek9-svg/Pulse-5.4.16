'use strict';

/**
 * Import an Edmonton Wholesale Market Receiving Report workbook into /financial tables.
 *
 * Usage:
 *   node scripts/import-edmonton-receiving-workbook.cjs "path/to/report.xlsx"
 *   node scripts/import-edmonton-receiving-workbook.cjs "path/to/report.xlsx" --data-dir "E:\Live\TGPV5\TGP_V5"
 *
 * Options:
 *   --data-dir <path>     TGP_DATA_DIR (folder containing tgp_ops.db)
 *   --replace-period      Delete existing rows for the imported period first
 *   --no-fill-sales       Skip synthesizing sales when Sales Numbers cells are empty
 *   --dry-run             Parse only, do not write (skips DB init/migrations)
 */

const fs = require('fs');
const path = require('path');

const appRoot = path.join(__dirname, '..');

const { importWorkbookToDb } = require('../src/lib/edmonton-receiving-workbook-import.cjs');

function parseArgs(argv) {
    const out = {
        workbook: '',
        dataDir: process.env.TGP_DATA_DIR || path.join(appRoot, '..', '..'),
        replacePeriod: false,
        fillSales: true,
        dryRun: false,
        dataDirExplicit: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--data-dir') {
            const raw = argv[i + 1];
            if (!raw || String(raw).startsWith('-')) {
                throw new Error('--data-dir requires a path argument.');
            }
            out.dataDir = path.resolve(raw);
            out.dataDirExplicit = true;
            i += 1;
        } else if (arg === '--replace-period') out.replacePeriod = true;
        else if (arg === '--no-fill-sales') out.fillSales = false;
        else if (arg === '--dry-run') out.dryRun = true;
        else if (!arg.startsWith('-') && !out.workbook) out.workbook = path.resolve(arg);
    }
    if (!out.workbook) {
        throw new Error('Workbook path required.');
    }
    if (out.dataDirExplicit) {
        if (!fs.existsSync(out.dataDir) || !fs.statSync(out.dataDir).isDirectory()) {
            throw new Error(`--data-dir is not a directory: ${out.dataDir}`);
        }
    }
    if (!fs.existsSync(out.workbook) || !fs.statSync(out.workbook).isFile()) {
        throw new Error(`Workbook not found: ${out.workbook}`);
    }
    return out;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    process.env.TGP_DATA_DIR = opts.dataDir;

    if (opts.dryRun) {
        const summary = await importWorkbookToDb(null, opts.workbook, {
            replacePeriod: opts.replacePeriod,
            fillSales: opts.fillSales,
            dryRun: true,
            actor: 'workbook-import',
        });
        console.log(JSON.stringify(summary, null, 2));
        return;
    }

    const { runMigrations } = require('../src/migrations/runner.cjs');
    const { db, initializeSettings, initializeDailyRhythm } = require('../src/db.cjs');
    initializeSettings();
    initializeDailyRhythm();
    runMigrations(db);

    const summary = await importWorkbookToDb(db, opts.workbook, {
        replacePeriod: opts.replacePeriod,
        fillSales: opts.fillSales,
        dryRun: false,
        actor: 'workbook-import',
    });

    console.log(JSON.stringify(summary, null, 2));
    console.log(`Imported into ${path.join(opts.dataDir, 'tgp_ops.db')}`);
    if (summary.synthesized_sales) {
        console.log(`Note: synthesized ${summary.synthesized_sales} sales cells from purchases (Sales Numbers was empty).`);
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message || e);
        process.exit(1);
    });
}

module.exports = { parseArgs };
