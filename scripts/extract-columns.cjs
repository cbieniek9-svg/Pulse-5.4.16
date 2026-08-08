'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const targetX = Number(process.argv[3]);
const tol = Number(process.argv[4] || 4);
const minSize = Number(process.argv[5] || 15);

const boxes = JSON.parse(fs.readFileSync(file, 'utf8'));
const col = boxes
    .filter((b) => Math.abs(b.x - targetX) <= tol && b.size >= minSize)
    .sort((a, b) => b.y - a.y);

console.log(`x≈${targetX} size>=${minSize}: ${col.length}`);
for (const b of col) console.log(`  ${b.x}, ${b.y}`);
if (col.length >= 2) {
    const gaps = [];
    for (let i = 1; i < col.length; i += 1) gaps.push(+(col[i - 1].y - col[i].y).toFixed(1));
    console.log('gaps', gaps.join(', '));
    console.log('avgGap', (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2));
}
