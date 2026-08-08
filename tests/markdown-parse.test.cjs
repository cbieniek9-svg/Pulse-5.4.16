const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdownOcrText, parseFlexibleDate, extractDatesFromLine } = require('../src/lib/markdown-parse.cjs');

test('parseFlexibleDate handles common retail formats', () => {
    assert.equal(parseFlexibleDate('2026-05-20'), '2026-05-20');
    assert.equal(parseFlexibleDate('05/20/2026'), '2026-05-20');
    assert.equal(parseFlexibleDate('20 MAY 2026'), '2026-05-20');
    assert.equal(parseFlexibleDate('BB: 05-20-26'), '2026-05-20');
});

test('parseMarkdownOcrText extracts inline product rows', () => {
    const text = `
        DAIRY MARKDOWN
        2% MILK 4L 060383012345 05/20/2026
        GREEK YOGURT 500G  2026-05-22
    `;
    const { candidates, stats } = parseMarkdownOcrText(text);
    assert.ok(candidates.length >= 2, `expected 2+ rows, got ${candidates.length}`);
    assert.ok(stats.high_confidence + stats.medium_confidence >= 1);
    const milk = candidates.find((c) => /milk/i.test(c.item));
    assert.ok(milk);
    assert.equal(milk.zone, 'Dairy');
    assert.equal(milk.kill_date, '2026-05-20');
    assert.equal(milk.item_code, '060383012345');
});

test('parseMarkdownOcrText pairs date-only lines with previous description', () => {
    const text = `
        CHOC CHIP COOKIES 500G
        BEST BEFORE 05/21/2026
        BANANA BREAD LOAF
        EXP 2026-05-23
    `;
    const { candidates } = parseMarkdownOcrText(text);
    assert.equal(candidates.length, 2);
    assert.match(candidates[0].item, /COOKIES|BANANA/);
    assert.ok(candidates.every((c) => c.kill_date.startsWith('2026-05')));
});

test('parseMarkdownOcrText reads tabular columns', () => {
    const text = 'DESCRIPTION          UPC           BB DATE\nORGANIC SPINACH 5OZ  008123456789  05/24/2026';
    const { candidates } = parseMarkdownOcrText(text);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].item, /SPINACH/i);
    assert.equal(candidates[0].item_code, '008123456789');
    assert.equal(candidates[0].kill_date, '2026-05-24');
});

test('parseMarkdownOcrText skips header noise', () => {
    const text = 'PAGE 1 OF 2\nTOTAL\nSKU DESCRIPTION UPC DATE\nWATER 24PK  06/01/2026';
    const { candidates } = parseMarkdownOcrText(text);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].item, /WATER/i);
});

test('extractDatesFromLine finds label-prefixed dates', () => {
    const dates = extractDatesFromLine('USE BY 05-19-2026');
    assert.deepEqual(dates, ['2026-05-19']);
});

test('retail markdown OCR fixture extracts multiple product rows', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const text = fs.readFileSync(path.join(__dirname, 'fixtures/markdown-ocr-sample.txt'), 'utf8');
    const { candidates, stats } = parseMarkdownOcrText(text);
    assert.ok(stats.candidate_count >= 8, `expected 8+ rows, got ${stats.candidate_count}`);
    const june = candidates.find((c) => /Cwico|Twigz|Tim Portas|Coffee|ice cream/i.test(c.item));
    assert.ok(june, 'expected at least one recognizable product name');
    const withDate = candidates.filter((c) => c.kill_date && /^\d{4}-\d{2}-\d{2}$/.test(c.kill_date));
    assert.ok(withDate.length >= 5, 'expected multiple rows with ISO kill dates');
});

test('full OCR PDF fixture uses vendor section mode without page noise', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const fixture = path.join(__dirname, 'fixtures/markdown-ocr-full.txt');
    if (!fs.existsSync(fixture)) return;
    const text = fs.readFileSync(fixture, 'utf8');
    const { candidates, stats } = parseMarkdownOcrText(text);
    assert.equal(stats.vendor_section_mode, true);
    assert.ok(stats.candidate_count >= 5 && stats.candidate_count <= 12);
    assert.ok(candidates.some((c) => /Pelocrema|Coffee|Tim Portas|JJUSS|ice foam/i.test(c.item)));
    assert.ok(!candidates.some((c) => /^NUE SD/i.test(c.item)));
});

test('multi-page vendor sheet keeps rows from page 2 after page footer', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const text = fs.readFileSync(path.join(__dirname, 'fixtures/markdown-ocr-multipage.txt'), 'utf8');
    const { candidates, stats } = parseMarkdownOcrText(text);
    assert.equal(stats.vendor_section_mode, true);
    assert.ok(stats.candidate_count >= 3, `expected 3+ rows across pages, got ${stats.candidate_count}`);
    assert.ok(candidates.some((c) => /Tim Hortons/i.test(c.item)), 'page 2 Tim Hortons');
    assert.ok(candidates.some((c) => /Melitta|Bellacrema/i.test(c.item)), 'page 2 Melitta');
    assert.ok(candidates.some((c) => /Coffee pod|Co-op/i.test(c.item)), 'page 1 Co-op');
});

test('FIFO audit log fixture extracts handwritten-style rows', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const text = fs.readFileSync(path.join(__dirname, 'fixtures/markdown-ocr-fifo-audit.txt'), 'utf8');
    const { candidates, stats } = parseMarkdownOcrText(text);
    assert.equal(stats.fifo_audit_mode, true);
    assert.equal(candidates.length, 2);
    const tim = candidates.find((c) => /Tim Hortons/i.test(c.item));
    const mel = candidates.find((c) => /Melitta|Bellacrema/i.test(c.item));
    assert.ok(tim, 'Tim Hortons row');
    assert.equal(tim.kill_date, '2026-04-10');
    assert.equal(tim.item_code, '6320911763');
    assert.equal(tim.zone, 'A5');
    assert.ok(mel, 'Melitta row');
    assert.equal(mel.kill_date, '2026-07-04');
});

test('extractRetailMarkdownDates parses mangled vendor sheet tails', () => {
    const { extractRetailMarkdownDates } = require('../src/lib/markdown-parse.cjs');
    const d1 = extractRetailMarkdownDates('53316 5599 Co-0P cold Coffee pod Iv-0& 2026', 2026);
    assert.ok(d1.includes('2026-11-03') || d1.some((x) => x.startsWith('2026-11')), d1.join(','));
    const d2 = extractRetailMarkdownDates('Pelocrema. 907s TL 04 - 2024', 2026);
    assert.ok(d2.includes('2024-04-04') || d2.includes('2024-04-04'), d2.join(','));
    const d3 = extractRetailMarkdownDates('June. 25,26', 2026);
    assert.ok(d3.includes('2026-06-25'), d3.join(','));
});
