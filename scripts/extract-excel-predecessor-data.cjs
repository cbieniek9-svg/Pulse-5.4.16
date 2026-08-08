'use strict';
/**
 * Extract seed JSON from archived Excel predecessors.
 * Default source: resources/Doc/archive/excel-predecessors/
 * Output: store-templates/default/*.json
 */
const fs = require('fs');
const path = require('path');
const { readSpreadsheetFile } = require('../src/lib/spreadsheet-read.cjs');

const appRoot = path.join(__dirname, '..');
const archiveRoot = path.join(appRoot, '..', 'Doc', 'archive', 'excel-predecessors');
const outDir = path.join(appRoot, 'store-templates', 'default');

const XLSM = path.join(archiveRoot, 'Store_Command_Center_v2 (1).xlsm');
const OD2 = path.join(archiveRoot, '_extracted_od2');

function sheetByName(workbook, sheetName) {
    return (workbook.sheets || []).find((s) => s.name === sheetName) || null;
}

function readRows(workbook, sheetName) {
    const sheet = sheetByName(workbook, sheetName);
    if (!sheet) return [];
    // Match prior sheet_to_json({ header: 1, defval: '' }) empty-cell behavior
    return (sheet.rows || []).map((row) => {
        const src = row || [];
        const out = [];
        for (let i = 0; i < src.length; i += 1) {
            const v = src[i];
            out.push(v === null || v === undefined ? '' : v);
        }
        return out;
    });
}

function norm(s) {
    return String(s ?? '').trim();
}

function extractTaskLibrary(wb) {
    const rows = readRows(wb, 'Task_Library');
    const baselines = [];
    const quickMiss = [];
    let inQuick = false;
    for (const r of rows.slice(5)) {
        const name = norm(r[2]);
        const dept = norm(r[3]);
        const freq = norm(r[5]);
        const day = norm(r[6]);
        const mins = Number(r[7] || 0);
        if (!name || name === 'Task Name') continue;
        if (/quick miss/i.test(name)) {
            inQuick = true;
            continue;
        }
        if (inQuick) {
            if (name && !name.startsWith('📋')) quickMiss.push({ check: name, est_mins: mins || 3 });
            continue;
        }
        baselines.push({
            detail: name,
            department: dept,
            frequency: freq,
            day_of_week: day,
            est_mins: mins > 0 ? mins : 15,
        });
    }

    const timeRows = readRows(wb, 'Time_Budget');
    const timeBudget = [];
    for (const r of timeRows.slice(3)) {
        const task = norm(r[0]);
        if (!task || task === 'Task') continue;
        const dailyHrs = Number(r[6] || 0);
        if (dailyHrs > 0) {
            timeBudget.push({ task, category: norm(r[1]), daily_equiv_hours: dailyHrs });
            const match = baselines.find((b) => b.detail === task);
            if (match && dailyHrs * 60 > match.est_mins) match.est_mins = Math.round(dailyHrs * 60);
        }
    }

    const rhythmMap = [
        { excel: /store walk/i, rhythm: 'Store walk' },
        { excel: /back stock/i, rhythm: 'Back stock' },
        { excel: /clean shelves/i, rhythm: 'Clean Shelves' },
        { excel: /fifo/i, rhythm: 'FIFO Audit' },
        { excel: /level off|straighten displays/i, rhythm: 'Level off displays' },
        { excel: /dead display/i, rhythm: 'Work dead displays to home' },
        { excel: /dots/i, rhythm: 'Update DOTS' },
        { excel: /freezer/i, rhythm: 'Check freezer for fallen items' },
        { excel: /orders \(centre store\)|tgp order/i, rhythm: 'TGP Order' },
    ];
    const rhythm_est_mins = {};
    baselines.forEach((b) => {
        for (const { excel, rhythm } of rhythmMap) {
            if (excel.test(b.detail)) {
                rhythm_est_mins[rhythm] = Math.max(rhythm_est_mins[rhythm] || 0, b.est_mins);
            }
        }
    });

    return {
        source: 'Store_Command_Center_v2.xlsm → Task_Library + Time_Budget',
        extracted_at: new Date().toISOString().slice(0, 10),
        baselines,
        time_budget: timeBudget,
        rhythm_est_mins,
        quick_miss_checks: quickMiss,
    };
}

function extractVendors(wb) {
    const rows = readRows(wb, 'Vendors');
    const contacts = [];
    for (const r of rows.slice(1)) {
        const vendor = norm(r[1]);
        if (!vendor || vendor === 'Vendor') continue;
        contacts.push({
            vendor,
            category: norm(r[2]),
            rep: norm(r[3]),
            phone: norm(r[4]),
            email: norm(r[5]),
            order_days: norm(r[6]),
            delivery_days: norm(r[7]),
            cutoff: norm(r[8]),
            order_method: norm(r[9]),
            lead_time_days: Number(r[10] || 0) || null,
            case_rules: norm(r[11]),
        });
    }
    return { source: 'Store_Command_Center_v2.xlsm → Vendors', extracted_at: new Date().toISOString().slice(0, 10), contacts };
}

function extractStoreWalk(wb) {
    const parseWalkSheet = (sheetName, kind) => {
        const rows = readRows(wb, sheetName);
        const sections = [];
        let current = null;
        for (const r of rows) {
            const c0 = norm(r[0]);
            const c1 = norm(r[1]);
            if (!c0 && !c1) continue;
            if (/^[🚪🥩🍎📋]/.test(c0) || (/^[0-9A-Z.]/.test(c0) && c0.length > 3 && !/^\d+$/.test(c0) && !c1 && !/WEEKLY|Walk the store|Rate each/i.test(c0))) {
                const title = c0.replace(/^[^\w]+/, '').trim();
                if (/WEEKLY|Walk the store|Rate each|Perishables tracked/i.test(title)) continue;
                current = { section: title, items: [] };
                sections.push(current);
                continue;
            }
            const num = Number(c0);
            if (current && Number.isFinite(num) && num > 0 && c1) {
                current.items.push({
                    id: num,
                    check: c1,
                    standard: norm(r[2]),
                });
            }
        }
        return { kind, sheet: sheetName, sections };
    };
    return {
        source: 'Store_Command_Center_v2.xlsm',
        extracted_at: new Date().toISOString().slice(0, 10),
        store_walk: parseWalkSheet('Store_Walk', 'store_walk'),
        perishables_walk: parseWalkSheet('Perishables_Walk', 'perishables_walk'),
    };
}

function sumGroceryHours(rows) {
    let total = 0;
    for (const r of rows.slice(2)) {
        const task = norm(r[0]);
        const hrs = Number(r[1]);
        if (task && Number.isFinite(hrs) && hrs > 0) total += hrs;
    }
    return Math.round(total * 100) / 100;
}

async function extractLaborMinimum(wb, od2Path) {
    const timeRows = readRows(wb, 'Time_Budget');
    let centerStoreDailyMin = 0;
    for (const r of timeRows.slice(3)) {
        const hrs = Number(r[6] || 0);
        if (hrs > 0) centerStoreDailyMin += hrs;
    }
    centerStoreDailyMin = Math.round(centerStoreDailyMin * 100) / 100;

    const settingsRows = readRows(wb, 'Settings');
    let softThreshold = 10;
    settingsRows.forEach((r) => {
        if (norm(r[0]) === 'Soft_Overage_Threshold_%') softThreshold = Number(r[1] || 10);
    });

    const byWeekday = {};
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dailyMinPath = path.join(od2Path, 'DailyMinimumTaskListHoursBydept2022Dec8.xlsx');
    if (fs.existsSync(dailyMinPath)) {
        const dm = await readSpreadsheetFile(dailyMinPath);
        days.forEach((day) => {
            if (!sheetByName(dm, day)) return;
            const rows = readRows(dm, day);
            byWeekday[day] = {
                minimum_hours: sumGroceryHours(rows),
                source: 'DailyMinimumTaskListHoursBydept2022Dec8.xlsx (Grocery column)',
            };
        });
    }
    days.forEach((day) => {
        if (!byWeekday[day]) {
            byWeekday[day] = {
                minimum_hours: centerStoreDailyMin,
                source: 'Time_Budget daily equiv (fallback)',
            };
        }
    });

    return {
        source: 'Time_Budget + DailyMinimumTaskListHoursBydept2022Dec8.xlsx',
        extracted_at: new Date().toISOString().slice(0, 10),
        soft_overage_threshold_pct: softThreshold,
        center_store_daily_equiv_hours: centerStoreDailyMin,
        by_weekday: byWeekday,
    };
}

function ensureOd2Extracted() {
    const zipPath = path.join(archiveRoot, 'OneDrive_2_6-28-2026.zip');
    const marker = path.join(OD2, '.extracted');
    if (fs.existsSync(marker)) return OD2;
    if (!fs.existsSync(zipPath)) return OD2;
    fs.mkdirSync(OD2, { recursive: true });
    const { execSync } = require('child_process');
    execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${OD2.replace(/'/g, "''")}' -Force"`, { stdio: 'inherit' });
    fs.writeFileSync(marker, new Date().toISOString());
    return OD2;
}

function writeJson(name, data) {
    const p = path.join(outDir, name);
    fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    console.log('  wrote', p);
}

async function main() {
    if (!fs.existsSync(XLSM)) {
        console.error('Missing archive xlsm:', XLSM);
        process.exit(1);
    }
    console.log('Reading', XLSM);
    const wb = await readSpreadsheetFile(XLSM);
    const od2 = ensureOd2Extracted();

    writeJson('task-estimate-baselines.json', extractTaskLibrary(wb));
    writeJson('vendor-directory.json', extractVendors(wb));
    writeJson('audit-walk-templates.json', extractStoreWalk(wb));
    writeJson('labor-minimum-baseline.json', await extractLaborMinimum(wb, od2));
    console.log('\nDone. Commit store-templates/default/*.json after review.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
