'use strict';
const { parseWorkbookFile, summarizeWorkbook } = require('../src/lib/edmonton-receiving-workbook-import.cjs');

function cellDate(value) {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const s = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return '';
}

async function main() {
    const wb = await parseWorkbookFile('e:\\9. Edmonton Wholesale Market Receiving Report 2026Jul18.xlsx');
    const rt = wb.Sheets['Receiving Totals'];
    const summary = summarizeWorkbook(wb, {});

    const byDate = new Map();
    summary._dailySheets.forEach((day) => {
        let g = 0;
        let d = 0;
        day.lines.forEach((l) => {
            g += Number(l.grocery || 0);
            d += Number(l.dairy || 0);
        });
        byDate.set(day.storeDate, { g, d, freight: Number(day.freight || 0), lines: day.lines.length });
    });

    let freightG = 0;
    let freightD = 0;
    let mismatches = 0;
    for (let row = 2; row <= 36; row += 1) {
        const date = cellDate(rt[`A${row}`]?.v);
        if (!date) continue;
        const rtG = Number(rt[`B${row}`]?.v || 0);
        const rtD = Number(rt[`J${row}`]?.v || 0);
        const parsed = byDate.get(date) || { g: 0, d: 0, freight: 0, lines: 0 };
        const allocG = parsed.freight * 0.478;
        const allocD = parsed.freight * 0.142;
        freightG += allocG;
        freightD += allocD;
        const diffG = rtG - parsed.g;
        const diffD = rtD - parsed.d;
        if (Math.abs(diffG) > 0.02 || Math.abs(diffD) > 0.02) {
            mismatches += 1;
            if (mismatches <= 5) {
                console.log(date, {
                    rtG, lineG: parsed.g, diffG,
                    rtD, lineD: parsed.d, diffD,
                    freight: parsed.freight,
                    withFreightG: parsed.g + allocG,
                    withFreightD: parsed.d + allocD,
                });
            }
        }
    }

    console.log('--- totals ---');
    console.log('sum RT-line grocery diff', 568334.26 - 566079.61);
    console.log('sum freight alloc g,d', freightG, freightD, 'total', freightG + freightD);
    console.log('mismatch days', mismatches);
}

main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
});
