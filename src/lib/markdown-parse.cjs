'use strict';

/** Canonical zones for kill-date records (matches markdown.html dropdown). */
const ZONE_CANONICAL = [
    'Dairy', 'Bakery', 'Produce', 'Freezer',
    'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8',
    'Pop', 'Water', 'Jerry', 'Seasonal', 'General',
];

const ZONE_ALIASES = {
    dairy: 'Dairy', milk: 'Dairy', cooler: 'Dairy',
    bakery: 'Bakery', bread: 'Bakery', bake: 'Bakery',
    produce: 'Produce', fruit: 'Produce', veg: 'Produce', vegetable: 'Produce',
    freezer: 'Freezer', frz: 'Freezer', frozen: 'Freezer', rfz: 'Freezer', 'fs frz': 'Freezer', meat: 'Freezer',
    pop: 'Pop', soda: 'Pop', beverage: 'Pop',
    water: 'Water', jerry: 'Jerry', seasonal: 'Seasonal',
    general: 'General', grocery: 'General', groc: 'General',
    hba: 'A3', snack: 'A2', ethnic: 'A6', pet: 'A6',
    coffee: 'A5', paper: 'A7', pkg: 'A8', packages: 'A8',
};

const MONTH_NAMES = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
    jue: 6, /** OCR: Jue.une */ dune: 0, dane: 0,
    april: 4, july: 7,
};

/** Two-letter (OCR) month codes seen on vendor markdown sheets */
const MONTH_CODE_MAP = {
    JA: 1, FE: 2, FB: 2, FEB: 2, MR: 3, MAR: 3,
    AP: 4, APR: 4, TL: 4, /** OCR for Apr */ AX: 4,
    MY: 5, MAY: 5, MA: 10, OCT: 10,
    JN: 6, JU: 6, JUN: 6, IN: 6, /** IN-03 → June */
    JL: 7, JUL: 7, AU: 8, AUG: 8, AG: 8, HH: 8,
    SE: 9, SP: 9, SEP: 9,
    OC: 10, OCT: 10, OT: 10,
    NO: 11, NV: 11, IV: 11, NOV: 11,
    DE: 12, DEC: 12, DC: 12,
};

const NOISE_LINE = /^(page\s+\d+|\d+\s+of\s+\d+|total\b|subtotal|invoice|store\s*#|tel\b|phone\b|fax\b|printed\b|continued\b|need\s+sde|vendor\s*code\s*\(?\s*[a-z]?\s*\)?\s*$)$/i;

const DATE_LABEL = /\b(?:best\s*before|b\.?\s*b\.?|exp(?:iry)?|use\s*by|sell\s*by|pull\s*by|code\s*date|out\s*date|reprd?\s*dur[e]?)\b[:\s.-]*/gi;

const DATE_OCR_WORD = /\b(?:date|dune|dane|dae)\b/gi;

const HEADER_LINE = /\b(?:vendor\s*code|item\s*name|exp\s*\/\s*bb|exp\/bb|quang?ity)\b/i;

/**
 * @param {string} s
 */
function fixOcrDigits(s) {
    return String(s ?? '')
        .replace(/[|]/g, '1')
        .replace(/(\d)[oO](\d)/g, '$10$2')
        .replace(/(\d)[oO]\b/g, '$10')
        .replace(/\b[oO](\d)/g, '0$1')
        .replace(/(\d)[lI|!](\d)/g, '$11$2')
        .replace(/(\d)[lI|!]\b/g, '$11')
        .replace(/\b[lI|!](\d)/g, '1$1')
        .replace(/(\d)[sS](\d)/g, '$15$2')
        .replace(/[—–]/g, '-')
        .replace(/[©®]/g, '')
        // Keep "25,26" (day + 2-digit year); only merge commas that are clearly OCR glitches
        .replace(/(\d),(\d{2})\b/g, (match, a, b) => {
            const day = parseInt(a, 10);
            const yr = parseInt(b, 10);
            if (day >= 1 && day <= 31 && yr >= 20 && yr <= 99) return match;
            return `${a}${b}`;
        });
}

/**
 * @param {string|number} raw
 * @param {number} refYear
 */
function normalizeOcrYear(raw, refYear = new Date().getFullYear()) {
    if (raw == null || raw === '') return null;
    let s = String(raw).replace(/[oO]/g, '0').replace(/[bB]/g, '6').replace(/[^\d]/g, '');
    if (!s) return null;
    let n = parseInt(s, 10);
    if (Number.isNaN(n)) return null;
    if (s.length <= 2) n = 2000 + n;
  // OCR often reads 2026 as 2076 (7 vs 2)
    if (n >= 2070 && n <= 2099) n = 2020 + (n % 10);
    if (n >= 220 && n <= 299) n = 2000 + (n % 100);
    if (n >= 2670 && n <= 2689) n = 2000 + (n % 100);
    if (n < 100) n = 2000 + n;
    if (n < refYear - 3 || n > refYear + 8) return null;
    return n;
}

/**
 * @param {number} y
 * @param {number} m
 * @param {number} d
 */
function toIsoDate(y, m, d) {
    if (!y || m < 1 || m > 12 || d < 1 || d > 31) return '';
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * @param {string} token
 */
function parseOcrDayToken(token) {
    if (token == null || token === '') return null;
    let raw = String(token);
    if (/%\s*0/i.test(raw) || /%\s*0/.test(raw)) return 10;
    let s = raw.replace(/[&]/g, '3').replace(/[Oo]/g, '0').replace(/[lI|!]/g, '1');
    s = s.replace(/%/g, '1').replace(/[^\d]/g, '');
    if (!s) return null;
    const n = parseInt(s, 10);
    if (n >= 1 && n <= 31) return n;
    return null;
}

/**
 * @param {string} code
 * @param {number} refYear
 */
function monthFromCode(code, refYear) {
    const c = String(code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (MONTH_CODE_MAP[c]) return MONTH_CODE_MAP[c];
    if (c.length >= 3) {
        const key3 = c.slice(0, 3).toLowerCase();
        if (MONTH_NAMES[key3]) return MONTH_NAMES[key3];
        const key4 = c.slice(0, 4).toLowerCase();
        if (MONTH_NAMES[key4]) return MONTH_NAMES[key4];
    }
    return null;
}

/**
 * @param {string} raw
 * @param {number} refYear
 */
function parseFlexibleDate(raw, refYear = new Date().getFullYear()) {
    if (!raw) return '';
    let s = fixOcrDigits(String(raw).trim());
    s = s.replace(DATE_LABEL, '').replace(DATE_OCR_WORD, '').trim();
    if (!s) return '';

    let m = s.match(/\b(20\d{2})[-/. ](\d{1,2})[-/. ](\d{1,2})\b/);
    if (m) return toIsoDate(+m[1], +m[2], +m[3]);

    m = s.match(/\b(\d{1,2})[-/. ](\d{1,2})[-/. ](20\d{2}|\d{2,4})\b/);
    if (m) {
        const y = normalizeOcrYear(m[3], refYear);
        if (!y) return '';
        let a = +m[1];
        let b = +m[2];
        if (a > 12 && b <= 12) return toIsoDate(y, b, a);
        if (b > 12 && a <= 12) return toIsoDate(y, a, b);
        return toIsoDate(y, a, b);
    }

    m = s.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s*(\d{2,4})\b/i);
    if (m) {
        const mon = MONTH_NAMES[m[1].toLowerCase().replace(/\./g, '')];
        const y = normalizeOcrYear(m[3], refYear);
        if (mon && y) return toIsoDate(y, mon, +m[2]);
    }

    m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})\b/i);
    if (m) {
        const key = m[1].toLowerCase().replace(/\./g, '');
        const mon = MONTH_NAMES[key];
        if (mon) return toIsoDate(refYear, mon, +m[2]);
    }

    m = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})\b/i);
    if (m) {
        const mon = MONTH_NAMES[m[2].toLowerCase().slice(0, 3)];
        const y = normalizeOcrYear(m[3], refYear);
        if (mon && y) return toIsoDate(y, mon, +m[1]);
    }

    m = s.match(/\b([A-Za-z]{3,9})-(\d{1,2})-(20\d{2})\b/i);
    if (m) {
        const key = m[1].toLowerCase().replace(/\./g, '');
        const mon = MONTH_NAMES[key] || MONTH_NAMES[key.slice(0, 3)];
        const y = normalizeOcrYear(m[3], refYear);
        if (mon && y) return toIsoDate(y, mon, +m[2]);
    }

    if (!/\b\d{4}\b/.test(s)) {
        const t = Date.parse(`${s}, ${refYear}`);
        if (!Number.isNaN(t)) {
            const d = new Date(t);
            return toIsoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
        }
    }

    if (/^\d{6}$/.test(s)) {
        const yy = +s.slice(0, 2);
        const mm = +s.slice(2, 4);
        const dd = +s.slice(4, 6);
        const y = yy >= 70 ? 1900 + yy : 2000 + yy;
        return toIsoDate(y, mm, dd);
    }

    return '';
}

/**
 * Retail markdown sheet patterns (mangled OCR).
 * @param {string} line
 * @param {number} refYear
 * @returns {string[]}
 */
function extractRetailMarkdownDates(line, refYear) {
    const found = new Set();
    const add = (y, m, d) => {
        const iso = toIsoDate(y, m, d);
        if (iso) found.add(iso);
    };
    const cleaned = fixOcrDigits(line);

    // June. 25,26  /  June 25, 2026
    let re = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Jue)[a-z]*\.?\s+(\d{1,2})\s*[,.\s]+\s*(\d{2,4})\b/gi;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
        const mon = MONTH_NAMES[m[1].toLowerCase().replace(/\./g, '')] || MONTH_NAMES.jun;
        const y = normalizeOcrYear(m[3], refYear);
        if (mon && y) add(y, mon, +m[2]);
    }

    // May 22 (day only, no year)
    re = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b(?![\s,.\d])/gi;
    while ((m = re.exec(cleaned)) !== null) {
        const mon = MONTH_NAMES[m[1].toLowerCase().replace(/\./g, '')];
        if (mon) add(refYear, mon, +m[2]);
    }

    // TL 04 - 2024  /  HH -08 ~~ 226  /  MA -10 ~ 2076
    re = /\b([A-Za-z]{2,4})\s*[-–~]?\s*(\d{1,2})\s*[-–~.]+\s*(20\d{2}|2[o0]\d{2}|\d{3,4})\b/gi;
    while ((m = re.exec(cleaned)) !== null) {
        const mon = monthFromCode(m[1], refYear);
        const y = normalizeOcrYear(m[3], refYear);
        if (mon && y) add(y, mon, +m[2]);
    }

    // Iv-0& 2026  /  IN-03 - 202(  /  Fe ~Il - 2026  /  MR ~%0 -2o2b
    re = /\b([A-Za-z]{2,4})\s*[-–~.]([O0o&Il%!/\d]{1,3})\s*[-–~.]+\s*(20\d{2}|2[o0]\d[b6]|\d{2,4}|\d{3}\(?)\b/gi;
    while ((m = re.exec(cleaned)) !== null) {
        const mon = monthFromCode(m[1], refYear);
        const day = parseOcrDayToken(m[2]);
        let yRaw = m[3].replace(/[()]/g, '').replace(/[oO]/g, '0').replace(/[bB]/g, '6').replace(/[^\d]/g, '');
        if (yRaw.length === 3 && yRaw.startsWith('202')) yRaw = '2026';
        else if (yRaw.length === 3) yRaw = `20${yRaw.slice(-2)}`;
        const y = normalizeOcrYear(yRaw, refYear);
        if (mon && day && y) add(y, mon, day);
    }

    // Iv-0& 2026  (single dash before day, space before year)
    re = /\b([A-Za-z]{2,4})\s*[-–~]([O0o&Il%!/\d]{1,3})\s+(20\d{2}|2[o0]\d{2}|\d{2,4})\b/gi;
    while ((m = re.exec(cleaned)) !== null) {
        const mon = monthFromCode(m[1], refYear);
        const day = parseOcrDayToken(m[2]);
        const y = normalizeOcrYear(m[3], refYear);
        if (mon && day && y) add(y, mon, day);
    }

    // Trailing: ~Il - 2026  or  ~~ 226  or  dane 2676
    re = /(?:[-–~]{1,3}\s*)?([A-Za-z]{0,3})?\s*[-–~]+\s*(20\d{2}|2[o0]\d{2}|\d{3,4})\s*$/i;
    m = cleaned.match(re);
    if (m) {
        const y = normalizeOcrYear(m[2], refYear);
        if (y) {
            const codeRe = /\b([A-Za-z]{2,4})\s*[-–~]?\s*(\d{1,2})\s*[-–~]/gi;
            let codeMatch = null;
            let cm;
            while ((cm = codeRe.exec(cleaned)) !== null) codeMatch = cm;
            if (codeMatch) {
                const mon = monthFromCode(codeMatch[1], refYear);
                if (mon) add(y, mon, +codeMatch[2]);
            } else {
                const dayMatch = cleaned.match(/\b(\d{1,2})\s*[-–~]+\s*(?:20|2[o0])/i);
                if (dayMatch) add(y, refYear, +dayMatch[1]);
            }
        }
    }

    // Bracket mangled: [-/0- 2026  /  [ 2 pen  /  Tim Portas ... [-/0- 2026
    re = /\[([^\]]{0,12})\]\s*[-–~]+\s*(20\d{2}|2[o0]\d{2})/gi;
    while ((m = re.exec(cleaned)) !== null) {
        const y = normalizeOcrYear(m[2], refYear);
        if (!y) continue;
        const inner = m[1].replace(/[^\dOo&/]/g, ' ').replace(/&/g, '3').replace(/[Oo]/g, '0');
        const nums = inner.match(/\d{1,2}/g) || [];
        if (nums.length >= 2) add(y, +nums[0], +nums[1]);
        else if (nums.length === 1) add(y, +nums[0], 1);
    }
    re = /\[\s*([-–~/\dOo&]{1,10})\s*[-–~]?\s*(20\d{2}|2[o0]\d{2})/gi;
    while ((m = re.exec(cleaned)) !== null) {
        const y = normalizeOcrYear(m[2], refYear);
        if (!y) continue;
        const inner = m[1].replace(/[^\dOo&/]/g, ' ').replace(/&/g, '3').replace(/[Oo]/g, '0');
        const nums = inner.match(/\d{1,2}/g) || [];
        if (nums.length >= 2) {
            let mm = +nums[0];
            let dd = +nums[1];
            if (mm === 0 && dd > 0) mm = 10;
            if (dd === 0 && mm > 0) dd = 10;
            if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) add(y, mm, dd);
            else if (dd >= 1 && dd <= 12 && mm >= 1 && mm <= 31) add(y, dd, mm);
        } else if (nums.length === 1) {
            let day = +nums[0];
            if (day === 0) day = 10;
            if (day >= 1 && day <= 31) add(y, 10, day);
        }
    }

    // date/dune/dane + digits: Glrus dune 2676  /  dure. 24
    re = /\b(?:date|dune|dane|dae|dur[e]?)\b\.?\s*(\d{1,2})?(?:\s*[,.\s]+\s*)?(\d{2,4})\b/gi;
    while ((m = re.exec(cleaned)) !== null) {
        const y = normalizeOcrYear(m[2] || m[1], refYear);
        const day = m[1] && m[2] ? +m[1] : null;
        if (y && day) add(y, refYear, day);
        else if (y && !m[2]) add(y, refYear, 1);
    }

    // Lone mangled year at end after month-day tokens: ... 04 - 2024
    re = /\b(\d{1,2})\s*[-–~]+\s*(20\d{2}|2[o0]\d{2})\b/g;
    while ((m = re.exec(cleaned)) !== null) {
        const y = normalizeOcrYear(m[2], refYear);
        if (!y) continue;
        const before = cleaned.slice(Math.max(0, m.index - 8), m.index);
        const codeM = before.match(/([A-Za-z]{2})\s*$/);
        const mon = codeM ? monthFromCode(codeM[1], refYear) : null;
        if (mon) add(y, mon, +m[1]);
    }

    return [...found];
}

function stripUpcForDateScan(line) {
    return String(line ?? '').replace(/\b\d{8,14}\b/g, ' ');
}

function isHeaderLikeLine(line) {
    const t = String(line).trim();
    if (HEADER_LINE.test(t)) return true;
    if (/\b(description|product|item)\b/i.test(t) && /\b(upc|sku|code)\b/i.test(t) && /\b(date|bb)\b/i.test(t)) return true;
    if (/^(description|upc|sku|bb|date|qty|quantity|vendor)\b/i.test(t)) return true;
    return false;
}

/**
 * @param {string} line
 * @param {number} refYear
 */
function extractDatesFromLine(line, refYear = new Date().getFullYear()) {
    const cleaned = fixOcrDigits(stripUpcForDateScan(line));
    const found = new Set();
    const add = (d) => { if (d) found.add(d); };

    for (const d of extractRetailMarkdownDates(line, refYear)) add(d);

    cleaned.replace(DATE_LABEL, (match, _g, offset) => {
        add(parseFlexibleDate(cleaned.slice(offset + match.length, offset + match.length + 32), refYear));
        return match;
    });

    const globalPatterns = [
        /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g,
        /\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2}|\d{2,4})\b/g,
        /\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})\b/gi,
        /\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})\b/gi,
    ];
    for (const pattern of globalPatterns) {
        const r = new RegExp(pattern.source, pattern.flags);
        let m;
        while ((m = r.exec(cleaned)) !== null) {
            add(parseFlexibleDate(m[0], refYear));
        }
    }

    return [...found].sort();
}

function pickBestDate(dates, line) {
    if (!dates.length) return '';
    if (dates.length === 1) return dates[0];
    const afterLabel = [];
    let m;
    const labelRe = /\b(?:best\s*before|b\.?\s*b\.?|exp(?:iry)?|use\s*by|sell\s*by|date|dune|dane)\b[:\s-]*/gi;
    while ((m = labelRe.exec(line)) !== null) {
        const chunk = line.slice(m.index + m[0].length, m.index + m[0].length + 32);
        for (const d of extractDatesFromLine(chunk)) afterLabel.push(d);
    }
    if (afterLabel.length) return afterLabel[afterLabel.length - 1];
    const future = dates.filter((d) => d >= new Date().toISOString().slice(0, 10));
    const pool = future.length ? future : dates;
    return pool.reduce((a, b) => (a > b ? a : b));
}

function extractUpc(line) {
    const m = line.match(/\b(\d{8,14})\b/);
    if (m) return m[1];
    const spaced = line.match(/\b(\d)\s+(\d{5})\s+(\d{5})\s+(\d)\b/);
    if (spaced) return `${spaced[1]}${spaced[2]}${spaced[3]}${spaced[4]}`;
    return '';
}

/** Vendor / item code at start of markdown rows */
function extractVendorItemCode(line) {
    const m = String(line).match(/^\s*(\d{5,12}[A-Za-z]?|\d{3,6}\s+\d{3,4}\s+\d{2,4})/);
    return m ? m[1].replace(/\s/g, '') : '';
}

function detectZone(line) {
    const aisle = String(line).match(/\bAisle\s*(\d{1,2})\b/i);
    if (aisle) {
        const n = aisle[1];
        const label = `A${n}`;
        if (ZONE_CANONICAL.includes(label)) return label;
    }
    for (const z of ZONE_CANONICAL) {
        if (new RegExp(`\\b${z.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(line)) return z;
    }
    for (const [alias, zone] of Object.entries(ZONE_ALIASES)) {
        if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(line).toLowerCase())) return zone;
    }
    return 'General';
}

/** Handwritten / printed FIFO Audit Log (Expiration Date column, not Exp/BB vendor grid). */
function isFifoAuditSheet(text) {
    return /FIFO\s*Audit/i.test(text) && /Expiration\s*Date/i.test(text);
}

/**
 * @param {string} text
 * @param {number} refYear
 */
const FIFO_MONTH_OCR = {
    apr: 4, ape: 4, hoe: 4, ap: 4,
    jul: 7, july: 7, joly: 7, duly: 7, julv: 7,
    may: 5, jun: 6, jue: 6, mar: 3, feb: 2, jan: 1,
};

function normalizeFifoOcrYear(raw, refYear) {
    let y = parseInt(String(raw).replace(/\D/g, ''), 10);
    if (Number.isNaN(y)) return refYear;
    if (y < 100) y = 2000 + y;
    // Handwritten OCR often drops century digits (e.g. "303" for 2026).
    if (y >= 200 && y < 320) return refYear;
    if (y >= 200 && y < 1000) y = 2000 + (y % 100);
    if (y >= 2070 && y <= 2099) y = 2020 + (y % 10);
    return y;
}

/** Loose expiry tail for handwritten FIFO OCR (e.g. "~1O- 303" → Apr 10 2026). */
function parseFifoLooseExpiry(fragment, refYear) {
    const s = fixOcrDigits(fragment);
    const m = s.match(/\b([A-Za-z]{2,9})\s*[-~.]?\s*(\d{1,2})[oOlI]?\s*[-~.]?\s*(\d{2,4}|\d{3})\b/i);
    if (!m) return '';
    const monKey = m[1].toLowerCase().slice(0, 4);
    const mon = MONTH_NAMES[monKey] || MONTH_NAMES[monKey.slice(0, 3)] || FIFO_MONTH_OCR[monKey] || FIFO_MONTH_OCR[monKey.slice(0, 3)];
    const y = normalizeFifoOcrYear(m[3], refYear);
    if (!mon) return '';
    return toIsoDate(y, mon, +m[2]);
}

function extractLooseVendorCodes(blob) {
    const found = new Set();
    for (const m of blob.matchAll(/\b(\d{9,11})\b/g)) found.add(m[1]);
    for (const m of blob.matchAll(/\b(\d{4,6})\s+(\d{4,6})\b/g)) {
        const joined = `${m[1]}${m[2]}`.replace(/\D/g, '');
        if (joined.length >= 9 && joined.length <= 11) found.add(joined);
    }
    const digitsOnly = blob.replace(/[^\d\s]/g, ' ');
    for (const m of digitsOnly.matchAll(/(\d[\d\s]{8,12}\d)/g)) {
        const d = m[1].replace(/\s/g, '');
        if (d.length >= 9 && d.length <= 11) found.add(d);
    }
    return [...found];
}

function parseFifoAuditLine(line, refYear) {
    const l = fixOcrDigits(String(line || '')).trim();
    if (!l || l.length < 12) return null;
    const monthPart = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
    const m = l.match(new RegExp(
        `^(?:(?:${monthPart})\\s+\\d{1,2}\\s+)?(?:Aisle\\s*(\\d{1,2})\\s+)?(\\d{9,11})\\s+(.+?)\\s+\\d{1,2}\\s+(${monthPart})[- ](\\d{1,2})[- ](20\\d{2})\\s*$`,
        'i',
    ));
    if (!m) return null;
    const aisle = m[1] || '';
    const code = m[2].replace(/\s/g, '');
    const killDate = parseFlexibleDate(`${m[4]}-${m[5]}-${m[6]}`, refYear);
    if (!killDate) return null;
    let item = m[3]
        .replace(/\b(?:May|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b/gi, '')
        .replace(/\bAisle\s*\d+\b/gi, '')
        .trim();
    item = cleanItemDescription(item, killDate, code);
    if (!item || isJunkProductItem(item)) return null;
    const zoneLine = aisle ? `Aisle ${aisle}` : l;
    return {
        item,
        item_code: code,
        kill_date: killDate,
        zone: detectZone(zoneLine),
        source_line: l,
        parse_method: 'fifo-audit-line',
    };
}

function parseFifoAuditFromText(text, refYear) {
    const candidates = [];
    const errors = [];
    const rawLines = String(text || '').split(/\r?\n/);
    for (const line of rawLines) {
        const row = parseFifoAuditLine(line, refYear);
        if (!row) continue;
        let { confidence, score } = scoreRow(row, 'fifo-audit');
        if (score >= 70) confidence = 'high';
        else if (score >= 45) confidence = 'medium';
        else confidence = 'low';
        candidates.push({ ...row, confidence, score });
    }
    const blob = fixOcrDigits(String(text || '')).replace(/\s+/g, ' ');
    const monthPart = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
    const re = new RegExp(`\\b(\\d{9,11})\\b\\s+(.+?)\\s+\\d{1,2}\\s+(${monthPart})-(\\d{1,2})-(20\\d{2})\\b`, 'gi');
    let m;
    while ((m = re.exec(blob)) !== null) {
        const code = m[1].replace(/\s/g, '');
        const killDate = parseFlexibleDate(`${m[3]}-${m[4]}-${m[5]}`, refYear);
        if (!killDate) continue;
        let item = m[2]
            .replace(/\b(?:May|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b/gi, '')
            .replace(/\bAisle\s*\d+\b/gi, '')
            .trim();
        item = cleanItemDescription(item, killDate, code);
        if (!item || isJunkProductItem(item)) {
            errors.push(`FIFO audit: found code ${code} and ${killDate} but could not read product name.`);
            continue;
        }
        const source_line = m[0].trim();
        const ctxStart = Math.max(0, m.index - 80);
        const zoneContext = blob.slice(ctxStart, m.index + m[0].length);
        const row = {
            item,
            item_code: code,
            kill_date: killDate,
            zone: detectZone(zoneContext),
            source_line,
            parse_method: 'fifo-audit',
        };
        let { confidence, score } = scoreRow(row, 'fifo-audit');
        if (score >= 70) confidence = 'high';
        else if (score >= 45) confidence = 'medium';
        else confidence = 'low';
        candidates.push({ ...row, confidence, score });
    }

    if (!candidates.length) {
        const dateRe = /\b([A-Za-z]{2,9})\s*[-~.]?\s*(\d{1,2})[oOlI]?\s*[-~.]?\s*(\d{2,4}|\d{3})\b/gi;
        const dates = [];
        let dm;
        while ((dm = dateRe.exec(blob)) !== null) {
            const killDate = parseFifoLooseExpiry(dm[0], refYear);
            if (killDate) dates.push({ killDate, index: dm.index, raw: dm[0] });
        }
        const codes = extractLooseVendorCodes(blob);
        if (dates.length && !codes.length) {
            errors.push(
                'FIFO audit sheet detected and expiry date(s) were read, but vendor codes did not survive OCR. '
                + 'Enter rows manually in /markdown or retake a clearer photo (codes must be readable).'
            );
            for (const d of dates) {
                errors.push(`Possible expiry (verify): ${d.killDate} (from "${d.raw.trim()}")`);
            }
        }
        for (const code of codes) {
            const pos = blob.indexOf(code);
            if (pos < 0) continue;
            const near = dates.find((d) => Math.abs(d.index - pos) < 140);
            if (!near) continue;
            const slice = blob.slice(Math.min(pos, near.index), Math.max(pos, near.index) + 90);
            let item = slice
                .replace(new RegExp(code, 'g'), '')
                .replace(near.raw, '')
                .replace(/\bAisle\s*\d+\b/gi, '')
                .replace(/\b\d{1,2}\b/g, ' ')
                .trim();
            item = cleanItemDescription(item, near.killDate, code);
            if (!item || item.length < 6 || isJunkProductItem(item)) continue;
            const row = {
                item,
                item_code: code,
                kill_date: near.killDate,
                zone: detectZone(slice),
                source_line: slice.trim(),
                parse_method: 'fifo-audit-loose',
            };
            let { confidence, score } = scoreRow(row, 'fifo-audit');
            score = Math.max(0, score - 15);
            confidence = score >= 55 ? 'medium' : 'low';
            candidates.push({ ...row, confidence, score });
        }
    }

    const deduped = dedupeCandidates(candidates);
    return {
        candidates: deduped,
        errors,
        rawText: String(text || ''),
        stats: {
            line_count: String(text || '').split(/\r?\n/).filter((l) => l.trim()).length,
            candidate_count: deduped.length,
            high_confidence: deduped.filter((c) => c.confidence === 'high').length,
            medium_confidence: deduped.filter((c) => c.confidence === 'medium').length,
            low_confidence: deduped.filter((c) => c.confidence === 'low').length,
            vendor_sections: 0,
            vendor_section_mode: false,
            fifo_audit_mode: true,
        },
    };
}

function isNoiseLine(line) {
    const t = String(line).trim();
    if (!t || t.length < 2) return true;
    if (NOISE_LINE.test(t)) return true;
    if (isHeaderLikeLine(t)) return true;
    if (/^[-_=.*#]{1,4}$/.test(t)) return true;
    if (/^[\d%£€$]{1,4}$/.test(t)) return true;
    if (/^[A-Za-z]{1,2}$/.test(t)) return true;
    if (/^(I|A|Z|co|al|Th|Pp|Tf|If|NM|RT|Le|me|ba|v|ad)$/i.test(t)) return true;
    if (/^[\W]+$/.test(t)) return true;
    return false;
}

function splitColumns(line) {
    if (line.includes('\t')) return line.split('\t').map((c) => c.trim()).filter(Boolean);
    return line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
}

const RETAIL_DATE_TAIL = /(?:\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Jue)[a-z]*\.?\s+\d{1,2}[\s,.\d]*|\b[A-Za-z]{2,4}\s*[-–~.]+\s*[O0o&Il%!/\d]{0,3}\s*[-–~.]+\s*(?:20|2[o0])[\d(]{0,4}|\[\s*[^\]]*\]\s*[-–~]+\s*(?:20|2[o0])[\d]{0,4}|\b\d{1,2}\s*[-–~]+\s*(?:20|2[o0])[\d]{0,4})/gi;

function cleanItemDescription(text, killDate, itemCode = '') {
    let item = fixOcrDigits(String(text || ''));
    item = item.replace(DATE_LABEL, ' ').replace(DATE_OCR_WORD, ' ');
    item = item.replace(RETAIL_DATE_TAIL, ' ');
    item = item.replace(/\b(20\d{2})[-/. ](\d{1,2})[-/. ](\d{1,2})\b/g, ' ');
    item = item.replace(/\b(\d{1,2})[-/. ](\d{1,2})[-/. ](20\d{2}|\d{2,4})\b/g, ' ');
    item = item.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}[\s,.\d]*/gi, ' ');
    if (itemCode) item = item.replace(new RegExp(`\\b${itemCode}\\b`), ' ');
    item = item.replace(/^\s*\d{5,12}[A-Za-z]?\s+/, ' ');
    item = item.replace(/\b\d{8,14}\b/g, ' ');
    item = item.replace(/[^a-zA-Z0-9%&'./+\-\s]/g, ' ');
    item = item.replace(/^(item|product|description|sku|upc|bb|best\s*before|exp|zone|qty|quantity|vendor)\b[:\s-]*/gi, '');
    item = item.replace(/\s+/g, ' ').trim();
    if (item.length < 3) return '';
    if (/^\d+$/.test(item)) return '';
    if (/^(co-?op|co-?0p|juss|gold|loffee|pod)/i.test(item) && item.length < 12) return '';
    return item.slice(0, 120);
}

function scoreRow(row, method) {
    let score = 0;
    if (row.kill_date) score += 40;
    if (row.item && row.item.length >= 6) score += 35;
    else if (row.item && row.item.length >= 3) score += 20;
    if (row.item_code && row.item_code.length >= 8) score += 15;
    if (row.zone && row.zone !== 'General') score += 5;
    if (method === 'table') score += 5;
    if (method === 'retail-row' || method === 'vendor-section' || method === 'fifo-audit') score += 8;
    if (method === 'pair') score += 3;
    if (method === 'continuation') score -= 10;
    const confidence = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low';
    return { confidence, score };
}

function dedupeCandidates(rows) {
    const seen = new Set();
    return rows.filter((r) => {
        const key = `${r.kill_date}|${r.item_code}|${r.item}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function isVendorSubHeaderLine(line) {
    const t = String(line || '').trim();
    return /\bitem\s*name\b/i.test(t) && /\bexp\s*\/\s*bb|\bexp\/bb\b/i.test(t);
}

function isVendorHeaderContinued(line) {
    const t = String(line || '').trim();
    if (!t) return true;
    if (isVendorSubHeaderLine(t)) return true;
    if (HEADER_LINE.test(t)) return true;
    if (/^(dune|dane|dure|asus|dane\.\s*a\s*\d*)$/i.test(t)) return true;
    if (/^quang?ity$/i.test(t)) return true;
    return false;
}

/** @param {string} line */
function lineHasRetailDateTail(line) {
    return RETAIL_DATE_TAIL.test(String(line || ''));
}

/** @param {string[]} rawLines */
function findVendorSections(rawLines) {
    const sections = [];
    const n = rawLines.length;
    const isVendorHeader = (line) => /\bvendor\s*code\b/i.test(line);

    for (let i = 0; i < n; i++) {
        const line = fixOcrDigits(String(rawLines[i] || '')).trim();
        if (!isVendorHeader(line)) continue;

        let dataStart = i + 1;
        while (dataStart < n && dataStart < i + 10) {
            const l = fixOcrDigits(String(rawLines[dataStart] || '')).trim();
            if (!l) { dataStart++; continue; }
            if (isVendorHeaderContinued(l)) { dataStart++; continue; }
            if (isNoiseLine(l) && !lineHasRetailDateTail(l) && !extractVendorItemCode(l)) { dataStart++; continue; }
            break;
        }

        let dataEnd = dataStart;
        while (dataEnd < n) {
            const l = fixOcrDigits(String(rawLines[dataEnd] || '')).trim();
            if (dataEnd > dataStart && isVendorHeader(l)) break;
            dataEnd++;
        }

        while (dataEnd > dataStart) {
            const l = fixOcrDigits(String(rawLines[dataEnd - 1] || '')).trim();
            if (!l) { dataEnd--; continue; }
            if (isNoiseLine(l) && !lineHasRetailDateTail(l) && extractDatesFromLine(l, new Date().getFullYear()).length === 0) {
                dataEnd--;
                continue;
            }
            break;
        }

        if (dataEnd > dataStart) sections.push({ headerIdx: i, dataStart, dataEnd });
    }

    const sectionHasDatedRow = (s, refYear) => {
        for (let i = s.dataStart; i < s.dataEnd; i++) {
            const l = fixOcrDigits(String(rawLines[i] || '')).trim();
            if (!l || isNoiseLine(l)) continue;
            if (lineHasRetailDateTail(l) || extractDatesFromLine(l, refYear).length) return true;
        }
        return false;
    };

    if (sections.length > 1) {
        const refYear = new Date().getFullYear();
        const scored = sections.map((s) => {
            let score = 0;
            for (let i = s.dataStart; i < s.dataEnd; i++) {
                const l = fixOcrDigits(String(rawLines[i] || '')).trim();
                if (!l || isNoiseLine(l)) continue;
                if (lineHasRetailDateTail(l)) score += 3;
                if (extractVendorItemCode(l) || extractUpc(l)) score += 2;
                if (extractDatesFromLine(l, refYear).length) score += 1;
            }
            return { s, score };
        });
        scored.sort((a, b) => b.score - a.score);
        const best = scored[0].score;
        if (best > 0) {
            const kept = scored.filter((x) => x.score >= best * 0.9 || sectionHasDatedRow(x.s, refYear));
            if (kept.length) return kept.map((x) => x.s);
        }
    }
    return sections;
}

function isJunkProductItem(item) {
    const t = String(item || '').toLowerCase().trim();
    if (t.length < 4) return true;
    if (/^(qua?ng?ity|vendor|item\s*name|exp|sku|upc|description|page|total|quantity|dune|dane)$/.test(t)) return true;
    if (/^NUE\s+SD\b/i.test(t)) return true;
    if (/\bKunrs\b/i.test(t) && t.length < 40) return true;
    if (/^qua\s+ntity$/i.test(t)) return true;
    return false;
}

function rawLineInSection(rawIdx, sections) {
    return sections.findIndex((s) => rawIdx >= s.dataStart && rawIdx < s.dataEnd);
}

/**
 * @param {string} text
 */
function parseMarkdownOcrText(text) {
    const refYear = new Date().getFullYear();
    if (isFifoAuditSheet(text)) {
        return parseFifoAuditFromText(text, refYear);
    }
    const rawLines = String(text || '').split(/\r?\n/);
    const vendorSections = findVendorSections(rawLines);
    const vendorSectionMode = vendorSections.some((s) => s.dataEnd > s.dataStart);

    const lines = [];
    const lineSection = [];
    for (let i = 0; i < rawLines.length; i++) {
        const trimmed = fixOcrDigits(rawLines[i]).trim();
        if (isNoiseLine(trimmed)) continue;
        const sec = rawLineInSection(i, vendorSections);
        if (vendorSectionMode && sec < 0) continue;
        lines.push(trimmed);
        lineSection.push(sec);
    }

    const candidates = [];
    const errors = [];
    const usedLineIdx = new Set();

    const pushCandidate = (partial, lineIdx, method) => {
        const killDate = partial.kill_date || '';
        if (!killDate) return;
        const itemCode = partial.item_code || extractVendorItemCode(partial.source_line || '') || extractUpc(partial.source_line || '');
        const item = cleanItemDescription(partial.item || partial.source_line || '', killDate, itemCode);
        if (!item || isJunkProductItem(item)) {
            if (killDate) errors.push(`Line ${lineIdx + 1}: found date ${killDate} but could not identify product description.`);
            return;
        }
        const inVendor = lineSection[lineIdx] >= 0;
        const parseMethod = inVendor && method === 'retail-row' ? 'vendor-section' : method;
        const row = {
            item,
            item_code: itemCode,
            zone: partial.zone || detectZone(partial.source_line || ''),
            kill_date: killDate,
            source_line: partial.source_line || '',
            parse_method: parseMethod,
        };
        let { confidence, score } = scoreRow(row, parseMethod);
        if (inVendor) score += 12;
        if (score >= 70) confidence = 'high';
        else if (score >= 45) confidence = 'medium';
        else confidence = 'low';
        candidates.push({ ...row, confidence, score });
        usedLineIdx.add(lineIdx);
    };

    const allowLine = (idx) => !usedLineIdx.has(idx);

    // Primary: product row with inline / tail date (vendor sheets)
    lines.forEach((line, idx) => {
        if (!allowLine(idx)) return;
        const dates = extractDatesFromLine(line, refYear);
        if (!dates.length) return;
        const killDate = pickBestDate(dates, line);
        const itemCode = extractVendorItemCode(line) || extractUpc(line);
        const item = cleanItemDescription(line, killDate, itemCode);
        if (item && item.length >= 4) {
            pushCandidate({
                item, item_code: itemCode, kill_date: killDate, zone: detectZone(line), source_line: line,
            }, idx, 'retail-row');
        }
    });

    if (!vendorSectionMode) {
        lines.forEach((line, idx) => {
            if (!allowLine(idx)) return;
            const cols = splitColumns(line);
            if (cols.length < 2) return;
            const dates = cols.flatMap((c) => extractDatesFromLine(c, refYear));
            if (!dates.length) return;
            const killDate = pickBestDate(dates, line);
            const codeCol = cols.find((c) => /^\d{8,14}$/.test(c.replace(/\s/g, '')));
            const itemCode = codeCol ? codeCol.replace(/\s/g, '') : extractVendorItemCode(line);
            const descCols = cols.filter((c) => {
                if (extractDatesFromLine(c, refYear).length) return false;
                if (/^\d{8,14}$/.test(c.replace(/\s/g, ''))) return false;
                return cleanItemDescription(c, killDate).length >= 2;
            });
            const item = descCols.join(' ').trim() || cleanItemDescription(line, killDate, itemCode);
            if (item) {
                pushCandidate({ item, item_code: itemCode, kill_date: killDate, zone: detectZone(line), source_line: line }, idx, 'table');
            }
        });
    }

    // Date-only line paired with neighbor (same vendor section when in vendor mode)
    lines.forEach((line, idx) => {
        if (!allowLine(idx)) return;
        const dates = extractDatesFromLine(line, refYear);
        const itemOnLine = cleanItemDescription(line, dates[0] || '', extractUpc(line));
        if (!dates.length || itemOnLine) return;

        const killDate = pickBestDate(dates, line);
        const neighbors = [
            { offset: -1, line: lines[idx - 1], nIdx: idx - 1 },
            { offset: -2, line: lines[idx - 2], nIdx: idx - 2 },
            { offset: 1, line: lines[idx + 1], nIdx: idx + 1 },
        ].filter((n) => n.line && !isNoiseLine(n.line));

        let paired = false;
        for (const { line: neighbor, nIdx } of neighbors) {
            if (!allowLine(nIdx) || usedLineIdx.has(nIdx)) continue;
            if (vendorSectionMode && lineSection[idx] >= 0 && lineSection[nIdx] !== lineSection[idx]) continue;
            if (extractDatesFromLine(neighbor, refYear).length) continue;
            const itemCode = extractVendorItemCode(neighbor) || extractUpc(neighbor) || extractUpc(line);
            const item = cleanItemDescription(neighbor, killDate, itemCode);
            if (vendorSectionMode && !itemCode && (item.length < 15 || isJunkProductItem(item))) continue;
            if (item && item.length >= 3) {
                pushCandidate({
                    item, item_code: itemCode, kill_date: killDate,
                    zone: detectZone(`${neighbor} ${line}`),
                    source_line: `${neighbor} | ${line}`,
                }, idx, 'pair');
                usedLineIdx.add(nIdx);
                paired = true;
                break;
            }
        }
        if (!paired && !vendorSectionMode) {
            errors.push(`Line ${idx + 1}: date ${killDate} with no nearby product text.`);
        }
    });

    const deduped = dedupeCandidates(candidates);
    deduped.sort((a, b) => (b.score - a.score) || a.kill_date.localeCompare(b.kill_date));

    return {
        candidates: deduped,
        errors,
        rawText: lines.join('\n'),
        stats: {
            line_count: lines.length,
            candidate_count: deduped.length,
            high_confidence: deduped.filter((c) => c.confidence === 'high').length,
            medium_confidence: deduped.filter((c) => c.confidence === 'medium').length,
            low_confidence: deduped.filter((c) => c.confidence === 'low').length,
            vendor_sections: vendorSections.length,
            vendor_section_mode: vendorSectionMode,
        },
    };
}

module.exports = {
    ZONE_CANONICAL,
    findVendorSections,
    isFifoAuditSheet,
    parseFifoAuditFromText,
    parseMarkdownOcrText,
    parseFlexibleDate,
    extractDatesFromLine,
    extractRetailMarkdownDates,
    extractUpc,
    detectZone,
    cleanItemDescription,
};
