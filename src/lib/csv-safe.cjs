'use strict';

/** CSV cell quoting with formula-injection guard */
function csvCell(v) {
    let s = String(v ?? '').replace(/"/g, '""');
    if (s.startsWith('=') || s.startsWith('+') || s.startsWith('-') || s.startsWith('@')) s = `'${s}`;
    return `"${s}"`;
}

module.exports = { csvCell };
