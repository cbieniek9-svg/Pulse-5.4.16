const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('TV Daily Direction renders above map/FIFO aligned with Active Directives header', () => {
  const js = fs.readFileSync(path.join(root, 'public/tv/tv-dashboard.js'), 'utf8');
  assert.match(js, /function ensureDailyDirectionTopHost\(\)/);
  assert.match(js, /function renderDailyDirectionCommsBox\(floor\)/);
  assert.match(js, /\.col\.col-left/);
  assert.match(js, /leftCol\.classList\.add\('tv-has-daily-direction-top'\)/);
  assert.match(js, /leftCol\.insertBefore\(section, leftCol\.firstChild\)/);
  assert.match(js, /classList\.remove\('tv-has-daily-direction-top'\)/);
  assert.match(js, /id="tv-comms-header">DAILY DIRECTION/);
  assert.match(js, /tv-daily-direction-top-section/);
  assert.doesNotMatch(js, /function renderDailyDirectionDirectiveCard\(floor\)/);
  assert.doesNotMatch(js, /mapHost\.insertBefore\(section, mapHost\.firstChild\)/);
  assert.doesNotMatch(js, /dailyDirection \+/);
  assert.doesNotMatch(js, /NO FLOOR COMMS/);
  assert.doesNotMatch(js, /html \+= `<div id="tv-comms-section"/);
});

test('TV Daily Direction and Active Directives headers share aligned non-clipping metrics', () => {
  const css = fs.readFileSync(path.join(root, 'public/tv/tv-dashboard.css'), 'utf8');
  assert.match(css, /\.tv-daily-direction-top-section \{[\s\S]*padding: 0 !important;/);
  assert.match(css, /\.col\.col-left\.tv-has-daily-direction-top \{[\s\S]*justify-content: flex-start !important;/);
  assert.match(css, /\.col\.col-left\.tv-has-daily-direction-top \{[\s\S]*overflow-y: auto !important;/);
  assert.match(css, /\.tv-daily-direction-top-section \.tv-floor-comms-header,\s*#tv-col-center > \.section-header:first-child \{/);
  assert.match(css, /min-height: 1\.65rem !important;/);
  assert.match(css, /height: auto !important;/);
  assert.match(css, /max-height: none !important;/);
  assert.match(css, /padding-top: 3px !important;/);
  assert.match(css, /overflow: visible !important;/);
});


test('TV secondary column keeps Safety and Customer Orders while hiding OOS inventory flags', () => {
  const js = fs.readFileSync(path.join(root, 'public/tv/tv-dashboard.js'), 'utf8');
  const overridesJs = fs.readFileSync(path.join(root, 'public/tv/tv-overrides.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public/tv/tv-dashboard.css'), 'utf8');
  const overridesCss = fs.readFileSync(path.join(root, 'public/tv/tv-overrides.css'), 'utf8');
  assert.match(js, /function renderRight\(data\)/);
  assert.match(js, /renderSafetyPanel\(data\)/);
  assert.match(js, /CUSTOMER ORDERS/);
  assert.match(js, /tv-customer-orders-section/);
  assert.match(js, /tv-customer-orders-block/);
  assert.match(js, /section-header tv-safety-header/);
  assert.doesNotMatch(js, /INVENTORY FLAGS \(OOS\)/);
  assert.doesNotMatch(js, /const oos = data\.oos \|\| \[\];/);
  assert.doesNotMatch(js, /oos\.slice\(/);
  assert.match(overridesJs, /tv-customer-orders-header/);
  assert.match(overridesJs, /tv-safety-header/);
  assert.match(overridesJs, /secondary\.after\(panel\)/);
  assert.doesNotMatch(overridesJs, /CUSTOMER ORDER\|VENDOR\|RECENT\|PERISHABLE\|INVENTORY\|SPECIAL/);
  assert.match(css, /\.tv-customer-orders-section \{[\s\S]*display: block !important;/);
  assert.match(css, /\.tv-customer-orders-block \{[\s\S]*display: flex !important;/);
  assert.match(overridesCss, /body\.tgp-tv-expiry-critical \.col-right \.tv-customer-orders-section/);
  assert.match(overridesCss, /body\.tgp-tv-expiry-critical \.col-right \.tv-safety-panel/);
});


test('TV 7-day expiry warnings render as a compact summary', () => {
  const overlays = fs.readFileSync(path.join(root, 'public/tv/tv-overrides.js'), 'utf8');
  assert.match(overlays, /UPCOMING EXPIRY/);
  assert.match(overlays, /due within 7 days/);
  assert.doesNotMatch(overlays, /7-DAY EXPIRY WARNING/);
});


test('TV order KPIs collapse to order-size chip when no TGP order is active or fixed weekday says non-order day', () => {
  const js = fs.readFileSync(path.join(root, 'public/tv/tv-dashboard.js'), 'utf8');
  assert.match(js, /function shouldShowFullOrderKpis\(data\)/);
  assert.match(js, /k\.shift_active \|\| k\.shift_done \|\| isTgpExpectedToday\(data\)/);
  assert.match(js, /function renderOrderSizeChip\(k, data\)/);
  assert.match(js, /tv-kpis-compact/);
  assert.match(js, /ORDER SIZE/);
  assert.match(js, /TGP TODAY/);
  assert.match(js, /const TGP_ORDER_WEEKDAYS = new Set\(\['sunday', 'tuesday', 'thursday'\]\)/);
  assert.match(js, /weekdayFromDateStamp/);
  assert.match(js, /TGP_ORDER_WEEKDAYS\.has\(today\)/);
  const overrides = fs.readFileSync(path.join(root, 'public/tv/tv-overrides.js'), 'utf8');
  assert.match(overrides, /function updateOrderSizeChip\(data\)/);
  assert.match(overrides, /liveOrderSizeTotal\(k\)/);
  assert.match(overrides, /updateOrderSizeChip\(data\)/);
  assert.match(overrides, /function captureShiftTickState\(data\)/);
  assert.match(overrides, /startShiftKpiTicker\(\)/);
});
