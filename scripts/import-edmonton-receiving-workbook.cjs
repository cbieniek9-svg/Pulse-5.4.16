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
 *   --dry-run             Parse only, do not write
 */

const path = require('path');

const appRoot = path.join(__dirname, '..');
process.env.TGP_DATA_DIR = process.env.TGP_DATA_DIR || path.join(appRoot, '..', '..');

const { runMigrations } = require('../src/migrations/runner.cjs');
const { importWorkbookToDb } = require('../src/lib/edmonton-receiving-workbook-import.cjs');

function parseArgs(argv) {
    const out = {
        workbook: '',
        dataDir: process.env.TGP_DATA_DIR,
        replacePeriod: false,
        fillSales: true,
        dryRun: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--data-dir') {
            out.dataDir = path.resolve(argv[i + 1] || '');
            i += 1;
        } else if (arg === '--replace-period') out.replacePeriod = true;
        else if (arg === '--no-fill-sales') out.fillSales = false;
        else if (arg === '--dry-run') out.dryRun = true;
        else if (!arg.startsWith('-') && !out.workbook) out.workbook = path.resolve(arg);
    }
    if (!out.workbook) {
        throw new Error('Workbook path required.');
    }
    return out;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    process.env.TGP_DATA_DIR = opts.dataDir;

    const { db, initializeSettings, initializeDailyRhythm } = require('../src/db.cjs');
    initializeSettings();
    initializeDailyRhythm();
    runMigrations(db);

    const summary = await importWorkbookToDb(db, opts.workbook, {
        replacePeriod: opts.replacePeriod,
        fillSales: opts.fillSales,
        dryRun: opts.dryRun,
        actor: 'workbook-import',
    });

    console.log(JSON.stringify(summary, null, 2));
    if (!opts.dryRun) {
        console.log(`Imported into ${path.join(opts.dataDir, 'tgp_ops.db')}`);
        if (summary.synthesized_sales) {
            console.log(`Note: synthesized ${summary.synthesized_sales} sales cells from purchases (Sales Numbers was empty).`);
        }
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e.message || e);
        process.exit(1);
    });
}

module.exports = { parseArgs };
