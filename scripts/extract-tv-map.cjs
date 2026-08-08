'use strict';
const fs = require('fs');
const path = require('path');
const s = fs.readFileSync(path.join(__dirname, '..', 'dist', 'assets', 'index-BmeQI9hM.js'), 'utf8');
// Map sections array: {id,x,y,w,h,label}
const re = /id:`([^`]+)`,x:(\d+),y:(-?\d+),w:(\d+),h:(\d+)(?:,label:`([^`]*)`)?/g;
const sections = [];
let m;
while ((m = re.exec(s))) {
    sections.push({ id: m[1], x: +m[2], y: +m[3], w: +m[4], h: +m[5], label: m[6] || m[1] });
}
console.log(JSON.stringify(sections, null, 2));
