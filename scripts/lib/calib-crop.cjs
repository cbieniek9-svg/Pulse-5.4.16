'use strict';

const fs = require('fs');
const jpeg = require('jpeg-js');

const PDF_W = 612;
const PDF_H = 792;

function jpegSize(filePath) {
    const decoded = jpeg.decode(fs.readFileSync(filePath), { useTArray: true });
    return { width: decoded.width, height: decoded.height };
}

function pdfToPix(W, H, x, y) {
    return {
        x: Math.round((x * W) / PDF_W),
        y: Math.round(((PDF_H - y) * H) / PDF_H),
    };
}

function pixToPdf(W, H, x, y) {
    return {
        x: Math.round((x * PDF_W) / W * 10) / 10,
        y: Math.round((PDF_H - (y * PDF_H) / H) * 10) / 10,
    };
}

function cropPdfRect(W, H, pdfX1, pdfY1, pdfX2, pdfY2) {
    const a = pdfToPix(W, H, pdfX1, pdfY1);
    const b = pdfToPix(W, H, pdfX2, pdfY2);
    return {
        left: Math.min(a.x, b.x),
        top: Math.min(a.y, b.y),
        right: Math.max(a.x, b.x),
        bottom: Math.max(a.y, b.y),
    };
}

module.exports = {
    PDF_W,
    PDF_H,
    jpegSize,
    pdfToPix,
    pixToPdf,
    cropPdfRect,
};
