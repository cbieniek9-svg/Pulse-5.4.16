'use strict';
const fs = require('fs');
const path = require('path');

const distRoot = path.join(__dirname, '..', 'dist');
const indexHtml = path.join(distRoot, 'index.html');
if (!fs.existsSync(indexHtml)) {
    console.error('dist/index.html missing');
    process.exit(1);
}
const html = fs.readFileSync(indexHtml, 'utf8');
const m = html.match(/src="(\/assets\/[^"]+\.js)"/);
if (!m) {
    console.error('No /assets/*.js module script found in dist/index.html');
    process.exit(1);
}
const bundlePath = path.join(distRoot, m[1].replace(/^\//, '').replace(/\//g, path.sep));
if (!fs.existsSync(bundlePath)) {
    console.error('Bundle missing:', bundlePath);
    process.exit(1);
}
const s = fs.readFileSync(bundlePath, 'utf8');
// Map sections array: {id,x,y,w,h,label}
const re = /id:`([^`]+)`,x:(\d+),y:(-?\d+),w:(\d+),h:(\d+)(?:,label:`([^`]*)`)?/g;
const sections = [];
let match;
while ((match = re.exec(s))) {
    sections.push({ id: match[1], x: +match[2], y: +match[3], w: +match[4], h: +match[5], label: match[6] || match[1] });
}
console.log(JSON.stringify(sections, null, 2));
