'use strict';
const jpeg = require('jpeg-js');
const fs = require('fs');
const path = require('path');
const calib = path.join(__dirname, '..', '_calib');
const Wpdf = 612; const Hpdf = 792;
const { width: W, height: H, data } = jpeg.decode(fs.readFileSync(path.join(calib, 'page-0.jpg')), { useTArray: true });
const gray = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return 255;
    return data[(y * W + x) * 4];
};
function score(x, y, size) {
    let e = 0; let en = 0; let l = 0; let d = 0; let n = 0;
    const g = (xx, yy) => gray(xx, yy);
    for (let i = 0; i < size; i += 1) {
        en += 4;
        if (g(x + i, y) < 110) e += 1;
        if (g(x + i, y + size - 1) < 110) e += 1;
        if (g(x, y + i) < 110) e += 1;
        if (g(x + size - 1, y + i) < 110) e += 1;
    }
    const pad = Math.max(2, Math.floor(size * 0.28));
    for (let iy = pad; iy < size - pad; iy += 1) {
        for (let ix = pad; ix < size - pad; ix += 1) {
            n += 1;
            const v = g(x + ix, y + iy);
            if (v > 175) l += 1;
            if (v < 130) d += 1;
        }
    }
    const er = e / en; const lr = l / Math.max(n, 1); const dr = d / Math.max(n, 1);
    if (er < 0.6 || lr < 0.5 || dr > 0.3) return 0;
    return er * 0.5 + lr * 0.5 - dr;
}
function search(pdfX, pdfY, r = 20) {
    const cx = Math.round((pdfX * W) / Wpdf);
    const cy = Math.round(((Hpdf - pdfY) * H) / Hpdf);
    let best = null;
    for (const size of [14, 15, 16, 17, 18]) {
        for (let y = cy - r; y <= cy + r; y += 1) {
            for (let x = cx - r; x <= cx + r; x += 1) {
                const s = score(x - Math.floor(size / 2), y - Math.floor(size / 2), size);
                if (s <= 0) continue;
                if (!best || s > best.s) {
                    best = {
                        s: +s.toFixed(3),
                        size,
                        x: Math.round((x * Wpdf) / W * 10) / 10,
                        y: Math.round((Hpdf - (y * Hpdf) / H) * 10) / 10,
                    };
                }
            }
        }
    }
    return best;
}
for (const t of [[110, 551, 'ft'], [255, 551, 'pt'], [400, 551, 'co'], [480, 551, 'cu'], [510, 551, 'cu2'], [398, 551, 'co2'], [430, 550, 'cu3']]) {
    console.log(t[2], search(t[0], t[1], 25));
}
const top = [];
for (let pdfX = 60; pdfX < 530; pdfX += 2) {
    const b = search(pdfX, 551, 6);
    if (b && b.s > 0.75) top.push(b);
}
const d = [];
for (const b of top.sort((a, b) => a.x - b.x)) {
    if (d.some((x) => Math.abs(x.x - b.x) < 8)) continue;
    d.push(b);
}
console.log('row', d);

// docs page 4 - scan yes/no columns
const { width: W4, height: H4, data: d4 } = jpeg.decode(fs.readFileSync(path.join(calib, 'page-4.jpg')), { useTArray: true });
function gray4(x, y) {
    if (x < 0 || y < 0 || x >= W4 || y >= H4) return 255;
    return d4[(y * W4 + x) * 4];
}
function score4(x, y, size) {
    let e = 0; let en = 0; let l = 0; let dk = 0; let n = 0;
    for (let i = 0; i < size; i += 1) {
        en += 4;
        if (gray4(x + i, y) < 110) e += 1;
        if (gray4(x + i, y + size - 1) < 110) e += 1;
        if (gray4(x, y + i) < 110) e += 1;
        if (gray4(x + size - 1, y + i) < 110) e += 1;
    }
    const pad = Math.max(2, Math.floor(size * 0.28));
    for (let iy = pad; iy < size - pad; iy += 1) {
        for (let ix = pad; ix < size - pad; ix += 1) {
            n += 1;
            const v = gray4(x + ix, y + iy);
            if (v > 175) l += 1;
            if (v < 130) dk += 1;
        }
    }
    const er = e / en; const lr = l / Math.max(n, 1); const dr = dk / Math.max(n, 1);
    if (er < 0.6 || lr < 0.5 || dr > 0.3) return 0;
    return er * 0.5 + lr * 0.5 - dr;
}
function search4(pdfX, pdfY, r = 12) {
    const cx = Math.round((pdfX * W4) / Wpdf);
    const cy = Math.round(((Hpdf - pdfY) * H4) / Hpdf);
    let best = null;
    for (const size of [14, 15, 16, 17, 18]) {
        for (let y = cy - r; y <= cy + r; y += 1) {
            for (let x = cx - r; x <= cx + r; x += 1) {
                const s = score4(x - Math.floor(size / 2), y - Math.floor(size / 2), size);
                if (s <= 0) continue;
                if (!best || s > best.s) {
                    best = {
                        s: +s.toFixed(3), size,
                        x: Math.round((x * Wpdf) / W4 * 10) / 10,
                        y: Math.round((Hpdf - (y * Hpdf) / H4) * 10) / 10,
                    };
                }
            }
        }
    }
    return best;
}
console.log('docs util yes @574', search4(105, 574, 18));
console.log('docs util no @574', search4(145, 574, 18));
console.log('docs copy yes @574', search4(430, 574, 18));
console.log('docs copy no @574', search4(495, 574, 18));
for (const y of [574, 557, 539, 522, 504, 486, 469, 451]) {
    const a = search4(105, y, 14);
    const b = search4(145, y, 14);
    const c = search4(419, y + 10, 14);
    const d2 = search4(484, y + 10, 14);
    console.log('row', y, { a, b, c, d2 });
}
