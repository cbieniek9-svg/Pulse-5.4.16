'use strict';
/**
 * CI / preflight: legacy React dist/ TV (deprecated — native shell in public/tv/ is supported path).
 */
const fs = require('fs');
const path = require('path');

const appRoot = path.join(__dirname, '..');
const indexPath = path.join(appRoot, 'dist', 'index.html');

if (!fs.existsSync(indexPath)) {
    console.warn('[check-tv] dist/index.html missing — legacy React TV not present (OK; use native TV shell)');
    process.exit(0);
}

console.warn('[check-tv] Legacy React dist/ TV detected — deprecated; TV_Native_Shell=1 is the supported path.');

const html = fs.readFileSync(indexPath, 'utf8');
const need = ['/public/tv/tv-overrides.css', '/public/tv/tv-overrides.js', '/public/js/tgp-stream.js', '/public/js/shift-pph-client.js'];
const missing = need.filter((s) => !html.includes(s));
if (missing.length) {
    console.error('[check-tv] dist/index.html is missing TV override references:', missing.join(', '));
    console.error('See public/tv/BUILD_NOTES.txt');
    process.exit(1);
}

if (!html.includes('src="/assets/') || !html.includes('href="/assets/')) {
    console.error('[check-tv] dist/index.html must use absolute /assets/ paths (required when served from /tv).');
    process.exit(1);
}

console.log('[check-tv] OK — deprecated React shell present and well-formed (native shell is the supported default)');
