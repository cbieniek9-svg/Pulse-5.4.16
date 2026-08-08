/**
 * TGP TV — settings-driven layout + expiry pull/warn alerts.
 * Works with both the legacy React shell (dist/) and native shell (tv-dashboard.html).
 * See public/tv/BUILD_NOTES.txt — run: npm run check:tv
 */
(function () {
    'use strict';

    function esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function readTvDisplayPrefs(data) {
        const s = data?.settings || {};
        const raw = data?.tv_display;
        const settingEnabled = (key, def = true) => {
            const v = s ? s[key] : undefined;
            if (v === undefined || v === null || v === '') return !!def;
            if (typeof v === 'boolean') return v;
            if (typeof v === 'number') return v !== 0;
            return !/^(0|false|off|no)$/i.test(String(v).trim());
        };
        if (raw && typeof raw === 'object') {
            return {
                showStoreComms: raw.showStoreComms !== false,
                showTicker: raw.showTicker !== false,
            };
        }
        return {
            showStoreComms: settingEnabled('TV_Show_Store_Comms', true),
            showTicker: settingEnabled('TV_Show_Ticker', false),
        };
    }

    function applyDisplayToggleGuards(data) {
        const prefs = readTvDisplayPrefs(data);
        // Store Comms no longer controls the Daily Direction box. Daily Direction
        // is handled by the native TV renderer and stays visible once posted.
        if (!prefs.showTicker) {
            const wrap = document.getElementById('tv-ticker-wrap');
            const tick = document.getElementById('tv-ticker');
            if (wrap) wrap.style.display = 'none';
            if (tick) tick.textContent = '';
        }
    }


    const ZC = window.TgpZoneColors;
    const ZONE_COLORS = ZC?.ZONE_COLORS || {
        'Zone 1': '#f90', 'Zone 2': '#0f8', 'Zone 3': '#0cf', 'Zone 4': '#f44', COMMAND: '#f44',
    };
    const UNMAPPED = ZC?.UNMAPPED || '#a855f7';
    const colorForZone = ZC?.colorForZone || ((zone) => (zone && ZONE_COLORS[zone] ? ZONE_COLORS[zone] : UNMAPPED));
    const colorForSection = ZC?.colorForSection || ((sectionId, zone) => colorForZone(zone));
    const applyTvFloorMapColors = ZC?.applyTvFloorMapColors || (() => {});

    /** Legacy React TV only — native shell paints the map in tv-dashboard.js. */
    function patchTvFloorMapColors(settings) {
        if (!settings || window.TgpTvNative) return;
        applyTvFloorMapColors(settings);
        setTimeout(() => applyTvFloorMapColors(settings), 150);
        setTimeout(() => applyTvFloorMapColors(settings), 700);
    }
    let storeTimezone = 'America/Toronto';
    let clockTimer = null;
    let streamLive = false;
    let lastSyncOk = 0;

    function ownerForKillZone(killZone, settings) {
        return window.TgpZoneOwners?.ownerForKillZone(killZone, settings) || '';
    }

    function ownerMeta(killZone, settings) {
        const name = ownerForKillZone(killZone, settings);
        return name ? ` · OWNER: ${name}` : '';
    }

    function formatStoreClock(now = new Date()) {
        const tz = storeTimezone || 'America/Toronto';
        const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now).toUpperCase();
        const dateLabel = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }).format(now).toUpperCase();
        const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(now);
        return { weekday, dateLabel, time };
    }

    function ensureStreamStatusBadge() {
        let el = document.getElementById('tgp-tv-stream-status');
        if (el) return el;
        const header = document.querySelector('.header');
        if (!header) return null;
        el = document.createElement('div');
        el.id = 'tgp-tv-stream-status';
        el.className = 'tgp-tv-stream-status is-reconnect';
        el.textContent = '… CONNECTING';
        header.appendChild(el);
        return el;
    }

    function updateStreamStatusBadge() {
        const el = ensureStreamStatusBadge();
        if (!el) return;
        const stale = !lastSyncOk || (Date.now() - lastSyncOk > 120000);
        if (streamLive && !stale) {
            el.className = 'tgp-tv-stream-status is-live';
            el.textContent = '● LIVE';
        } else if (lastSyncOk && !stale) {
            el.className = 'tgp-tv-stream-status is-poll';
            el.textContent = '↻ SYNC';
        } else {
            el.className = 'tgp-tv-stream-status is-reconnect';
            el.textContent = '⚠ RECONNECTING';
        }
    }

    function applyStoreClockToHeader(data) {
        const tz = data?.storeTimezone || data?.store?.timezone;
        if (tz) storeTimezone = tz;
        const headerInfo = document.querySelector('.header-info');
        if (!headerInfo) return;
        const kids = headerInfo.children;
        if (kids.length < 3) return;
        const fromServer = data?.storeWeekday && data?.storeDateLabel && data?.storeTime;
        const clock = fromServer
            ? { weekday: data.storeWeekday, dateLabel: data.storeDateLabel, time: data.storeTime }
            : formatStoreClock();
        kids[0].textContent = clock.weekday;
        kids[1].textContent = clock.dateLabel;
        kids[2].textContent = clock.time;
        kids[0].setAttribute('data-tgp-store-clock', '1');
    }

    function startStoreClockTicker() {
        if (clockTimer) return;
        clockTimer = setInterval(() => {
            const headerInfo = document.querySelector('.header-info');
            if (!headerInfo || !headerInfo.querySelector('[data-tgp-store-clock]')) return;
            const clock = formatStoreClock();
            const kids = headerInfo.children;
            if (kids.length >= 3) {
                kids[0].textContent = clock.weekday;
                kids[1].textContent = clock.dateLabel;
                kids[2].textContent = clock.time;
            }
        }, 250);
    }

    function hideLegacyPerishableSection() {
        document.querySelectorAll('.section-header').forEach((hdr) => {
            if (!/PERISHABLE/i.test(hdr.textContent || '')) return;
            hdr.style.display = 'none';
            let el = hdr.nextElementSibling;
            while (el && !el.classList.contains('section-header')) {
                if (el.classList.contains('card')) el.style.display = 'none';
                el = el.nextElementSibling;
            }
        });
    }

    function tagSecondaryBlocks() {
        document.querySelectorAll('.col-right .section-header').forEach((hdr) => {
            if (hdr.classList.contains('tgp-tv-secondary-header')) return;
            if (hdr.classList.contains('tv-customer-orders-header')) return;
            if (hdr.classList.contains('tv-safety-header')) return;
            const t = (hdr.textContent || '').toUpperCase();
            if (!/VENDOR|RECENT|PERISHABLE|INVENTORY|SPECIAL/.test(t)) return;
            hdr.classList.add('tgp-tv-secondary-header');
            let el = hdr.nextElementSibling;
            while (el && !el.classList.contains('section-header')) {
                if (!el.classList.contains('tv-customer-orders-section')
                    && !el.classList.contains('tv-customer-orders-block')
                    && !el.classList.contains('tv-safety-panel')) {
                    el.classList.add('tgp-tv-secondary-block');
                }
                el = el.nextElementSibling;
            }
        });
    }

    function applyRightColumnPriority(data) {
        const today = data.storeDate || '';
        const pullToday = (data.kill_dates || []).filter((k) => k.kill_date && today && k.kill_date <= today);
        const warnings = data.kill_warnings || [];
        const warnOnly = warnings.filter((w) => !pullToday.some((p) => p.id === w.id));
        document.body.classList.toggle('tgp-tv-expiry-critical', pullToday.length > 0);
        document.body.classList.toggle('tgp-tv-expiry-busy', pullToday.length > 0);
        tagSecondaryBlocks();
    }

    const TGP_ORDER_WEEKDAYS = new Set(['sunday', 'tuesday', 'thursday']);

    function normalizeWeekday(value) {
        const text = String(value || '').trim().toLowerCase();
        const short = text.slice(0, 3);
        const map = { sun: 'sunday', mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday' };
        return map[short] || text;
    }

    function weekdayFromDateStamp(value) {
        const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return '';
        const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
        if (!Number.isFinite(date.getTime())) return '';
        return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][date.getUTCDay()] || '';
    }

    function isTgpOrderDay(data) {
        const today = normalizeWeekday(data?.storeWeekday) || weekdayFromDateStamp(data?.storeDate);
        return TGP_ORDER_WEEKDAYS.has(today);
    }

    function liveOrderSizeTotal(k) {
        return Number(k?.g || 0) + Number(k?.f || 0) + Number(k?.h || 0);
    }

    function updateOrderSizeChip(data) {
        const k = data?.kpis || {};
        const total = liveOrderSizeTotal(k);
        const value = total > 0 ? `${total} pcs` : '—';
        const labelText = isTgpOrderDay(data) ? 'TGP TODAY' : 'ORDER SIZE';
        document.querySelectorAll('.kpi-order-size-chip, .kpi-tile').forEach((tile) => {
            const label = tile.querySelector('.kpi-tile-label');
            const val = tile.querySelector('.kpi-tile-value');
            if (!label || !val) return;
            const text = (label.textContent || '').trim().toUpperCase();
            if (tile.classList.contains('kpi-order-size-chip') || text === 'ORDER SIZE' || text === 'TGP TODAY') {
                label.textContent = labelText;
                val.textContent = value;
            }
        });
    }

    function applyShiftKpis(data, livePphOverride) {
        const k = data.kpis || {};
        const pph = livePphOverride != null ? livePphOverride : k.shift_pph;
        updateOrderSizeChip(data);
        document.querySelectorAll('.kpi-tile').forEach((tile) => {
            const label = tile.querySelector('.kpi-tile-label');
            const val = tile.querySelector('.kpi-tile-value');
            if (!label || !val) return;
            const text = (label.textContent || '').trim().toUpperCase();
            if (text.includes('ACTUAL') && text.includes('PPH')) {
                if (k.shift_active && pph != null) {
                    val.textContent = String(pph);
                    val.style.color = pph >= (k.shift_standard_pph || 55) ? '#0f8' : '#f90';
                } else if ((k.shift_done || !k.shift_active) && k.shift_pph_final != null) {
                    val.textContent = String(k.shift_pph_final);
                    val.style.color = '';
                }
            }
            if (text === 'STAFF' || text.includes('STAFF')) {
                val.textContent = String(k.order_staff != null ? k.order_staff : k.staff || 0);
                label.textContent = k.shift_active ? 'STAFF ON ORDER' : 'STAFF';
            }
        });
    }

    let shiftTickState = null;
    let shiftTickTimer = null;

    function captureShiftTickState(data) {
        const k = data?.kpis || {};
        const orderStart = data?.settings?.Order_Start;
        if (!k.shift_active || !orderStart) {
            shiftTickState = null;
            return;
        }
        const total = k.shift_total_pieces != null
            ? k.shift_total_pieces
            : (typeof TgpShiftPph !== 'undefined' && TgpShiftPph.resolveLiveOrderPieces
                ? TgpShiftPph.resolveLiveOrderPieces(k, data?.settings?.Hardware_Arrived)
                : (Number(k.g || 0) + Number(k.f || 0) + Number(k.h || 0)));
        shiftTickState = {
            orderStart,
            totalPieces: total,
            standard: k.shift_standard_pph || 55,
            orderStaff: k.order_staff,
            staff: k.staff,
        };
    }

    function tickShiftKpis() {
        if (!shiftTickState || typeof TgpShiftPph === 'undefined') return;
        const pph = TgpShiftPph.computeLiveShiftPph(shiftTickState.orderStart, shiftTickState.totalPieces);
        if (pph == null) return;
        document.querySelectorAll('.kpi-tile').forEach((tile) => {
            const label = tile.querySelector('.kpi-tile-label');
            const val = tile.querySelector('.kpi-tile-value');
            if (!label || !val) return;
            const text = (label.textContent || '').trim().toUpperCase();
            if (text.includes('ACTUAL') && text.includes('PPH')) {
                val.textContent = String(pph);
                val.style.color = pph >= shiftTickState.standard ? '#0f8' : '#f90';
            }
        });
    }

    function startShiftKpiTicker() {
        if (shiftTickTimer) return;
        shiftTickTimer = setInterval(tickShiftKpis, 30000);
    }

    function renderExpiryPanel(data) {
        const today = data.storeDate || '';
        const settings = data.settings || {};
        const warnings = data.kill_warnings || [];
        const allActive = data.kill_dates || [];
        const pullToday = allActive.filter((k) => k.kill_date && today && k.kill_date <= today);
        const warnOnly = warnings.filter((w) => !pullToday.some((p) => p.id === w.id));

        let panel = document.getElementById('tgp-tv-expiry');
        const colRight = document.querySelector('.col-right');
        const secondary = document.getElementById('tv-col-right-secondary');
        if (!panel && colRight) {
            panel = document.createElement('div');
            panel.id = 'tgp-tv-expiry';
        }
        if (panel && colRight) {
            if (secondary && secondary.parentElement === colRight) {
                secondary.after(panel);
            } else if (panel.parentElement !== colRight) {
                colRight.appendChild(panel);
            }
        }
        if (!panel) return;

        const blocks = [];
        if (pullToday.length) {
            blocks.push(`<div class="section-header tv-expiry-section-header" style="color:#f44;">PULL TODAY — EXPIRY</div>`);
            pullToday.forEach((k) => {
                blocks.push(`<div class="card urgent tv-expiry-pull">
                    <div class="tv-expiry-item-title"><span class="card-zone">${esc(k.zone || 'General')}</span> ${esc(k.item)}</div>
                    <div class="card-meta tv-expiry-item-meta">OUT DATE: ${esc(k.kill_date)} · PULL NOW${ownerMeta(k.zone, settings)}</div>
                </div>`);
            });
        }
        if (warnOnly.length) {
            const next = [...warnOnly].sort((a, b) => String(a.kill_date || '').localeCompare(String(b.kill_date || ''))).slice(0, 3);
            const summary = next.map((k) => {
                const days = k.days_until != null ? `${k.days_until}D` : '';
                const zone = k.zone ? `${k.zone}: ` : '';
                return `${zone}${k.item || 'item'}${days ? ` (${days})` : ''}`;
            }).join(' · ');
            blocks.push(`<div class="section-header tv-expiry-section-header tv-expiry-warning-compact-header" style="color:#f90;">UPCOMING EXPIRY</div>`);
            blocks.push(`<div class="card tv-expiry-warn tv-expiry-warning-compact">
                <div class="tv-expiry-item-title">${esc(warnOnly.length)} item${warnOnly.length === 1 ? '' : 's'} due within 7 days</div>
                <div class="card-meta tv-expiry-item-meta">${esc(summary)}${warnOnly.length > next.length ? ` · +${warnOnly.length - next.length} more` : ''}</div>
            </div>`);
        }
        if (!blocks.length) {
            panel.style.display = 'block';
            panel.innerHTML = `<div class="section-header tv-expiry-section-header" style="color:#0f8;">EXPIRY STATUS</div>
                <div class="card tv-expiry-calm"><div class="tv-expiry-item-title">No expiry pulls or warnings on the board.</div></div>`;
            hideLegacyPerishableSection();
            return;
        }
        panel.style.display = 'block';
        panel.innerHTML = blocks.join('');
        hideLegacyPerishableSection();
    }

    function renderFifoAislePanel(settings) {
        const mapHost = document.querySelector('.task-map-container.centric') || document.querySelector('.task-map-container');
        if (!mapHost) return;
        let panel = document.getElementById('tv-fifo-aisle-assignments');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'tv-fifo-aisle-assignments';
            panel.className = 'tv-fifo-assignments';
            mapHost.insertBefore(panel, mapHost.firstChild);
        }
        let rows = [];
        try { rows = JSON.parse(settings?.FIFO_Aisle_Assignments || '[]'); } catch (_) { /* ignore */ }
        if (!rows.length) {
            panel.innerHTML = '';
            panel.style.display = 'none';
            return;
        }
        panel.style.display = 'block';
        const sorted = [...rows].sort((a, b) => String(a.staff).localeCompare(String(b.staff)));
        panel.innerHTML = `
            <div class="tv-fifo-title">FIFO AUDIT ASSIGNMENTS</div>
            <div class="tv-fifo-grid">
                ${sorted.map((r) => `<div class="tv-fifo-chip">
                    <strong>${esc(r.staff)}</strong>
                    <small>${esc((r.aisles || []).join(' · '))}</small>
                </div>`).join('')}
            </div>`;
    }

    function applyNativeTvOverlays(data) {
        if (!data) return;
        lastSyncOk = Date.now();
        renderExpiryPanel(data);
        applyRightColumnPriority(data);
        applyShiftKpis(data);
        captureShiftTickState(data);
        startShiftKpiTicker();
        pinPullTasksInColumns(data);
        applyStoreClockToHeader(data);
        startStoreClockTicker();
        renderFifoAislePanel(data.settings || {});
        applyDisplayToggleGuards(data);
        updateStreamStatusBadge();
    }

    function pinPullTasksInColumns(data) {
        /* Pull work is shown in the expiry panel only — center column excludes AUTO-PULL tasks. */
        void data;
    }

    async function applyTvSync() {
        try {
            const res = await fetch('/api/sync');
            if (!res.ok) {
                updateStreamStatusBadge();
                return null;
            }
            const data = await res.json();
            lastSyncOk = Date.now();
            renderExpiryPanel(data);
            applyRightColumnPriority(data);
            applyShiftKpis(data);
            captureShiftTickState(data);
            startShiftKpiTicker();
            pinPullTasksInColumns(data);
            applyStoreClockToHeader(data);
            startStoreClockTicker();
            renderFifoAislePanel(data.settings || {});
            applyDisplayToggleGuards(data);
            updateStreamStatusBadge();
            return data;
        } catch (e) {
            console.error('[TV] sync overlay failed', e);
            updateStreamStatusBadge();
            return null;
        }
    }

    async function applyLayoutFromData(data) {
        if (!data) return;
        try {
            const s = data.settings || {};
            const styleEl = document.getElementById('tv-overrides');
            if (!styleEl) return;

            const tvScale = Math.min(2.0, Math.max(0.4, parseFloat(s.TV_Scale) || 1.0));
            const mapScale = Math.min(2.0, Math.max(0.3, parseFloat(s.TV_Map_Size) || 1.0));
            const kpiScale = Math.min(1.8, Math.max(0.6, parseFloat(s.TV_KPI_Size) || 1.0));
            const colSplit = (s.TV_Col_Split || '2,1,1').split(',').map((v) => parseFloat(v) || 1);
            const cols = colSplit.map((v) => v + 'fr').join(' ');
            document.body.style.zoom = tvScale;
            const mapZoom = (mapScale / tvScale).toFixed(4);

            const taskCount = (data.tasks || []).length;
            let cs = 1.0;
            if (taskCount > 8) cs = Math.max(0.6, 1.0 - (taskCount - 8) * 0.05);

            const css = `
              .task-map-container { zoom: ${mapZoom} !important; transform: none !important; }
              .main-content { grid-template-columns: ${cols} !important; gap: 8px !important; }
              .kpi-tile-value { font-size: ${(1.3 * kpiScale).toFixed(2)}rem !important; }
              .kpi-tile-label { font-size: ${(0.66 * Math.max(0.8, kpiScale)).toFixed(2)}rem !important; }
              .card {
                padding: ${Math.max(3, Math.round(8 * cs))}px ${Math.max(7, Math.round(12 * cs))}px !important;
                margin-bottom: ${Math.max(2, Math.round(6 * cs))}px !important;
                font-size: ${cs.toFixed(3)}em !important;
                min-height: 0 !important; line-height: 1.2 !important;
              }
              .card-meta { font-size: ${Math.max(0.56, 0.72 * cs).toFixed(3)}em !important; line-height:1.1 !important; }
              .card-meta-assignee { font-size: ${Math.max(0.78, 0.92 * cs).toFixed(3)}em !important; line-height:1.25 !important; font-weight:600 !important; }
              .section-header {
                font-size: ${Math.max(0.7, cs).toFixed(3)}em !important;
                margin-bottom: ${Math.max(3, Math.round(8 * cs))}px !important;
                padding-bottom: 2px !important;
              }
              #tgp-tv-expiry .tv-expiry-item-title { font-size: ${Math.max(1.0, 1.08 * cs).toFixed(3)}em !important; }
              #tgp-tv-expiry .tv-expiry-item-meta { font-size: ${Math.max(0.82, 0.95 * cs).toFixed(3)}em !important; }
              #tgp-tv-expiry .tv-expiry-section-header { font-size: ${Math.max(0.95, 1.05 * cs).toFixed(3)}em !important; }
              .tactical-svg .zone-label { font-size: ${Math.max(20, 22 * mapScale).toFixed(0)}px !important; }
              .tactical-svg .zone-sublabel { font-size: ${Math.max(13, 15 * mapScale).toFixed(0)}px !important; }
            `;
            styleEl.innerHTML = css;

            let zoneNames = { 'Zone 1': 'ZONE 1', 'Zone 2': 'ZONE 2', 'Zone 3': 'ZONE 3', 'Zone 4': 'ZONE 4', 'COMMAND': 'ZONE 4' };
            if (s.Zone_Names) {
                try {
                    Object.assign(zoneNames, JSON.parse(s.Zone_Names));
                } catch (_) { /* ignore */ }
            }

            if (s.Zone_Ownership) {
                try {
                    const owners = JSON.parse(s.Zone_Ownership);
                    const legend = document.getElementById('map-legend');
                    if (legend) {
                        legend.innerHTML = Object.entries(owners)
                            .map(([z, name]) => {
                                const color = colorForZone(z);
                                const zLabel = zoneNames[z] || (z === 'Zone 4' || z === 'COMMAND' ? 'Z4' : z);
                                return `<span><span style="color:${color}">■</span> ${esc(zLabel)}: ${esc(name)}</span>`;
                            })
                            .join('');
                    }
                    const cmdOwner = owners['Zone 4'] || owners['COMMAND'] || '';
                    const cmdLabel = zoneNames['Zone 4'] || zoneNames['COMMAND'] || 'ZONE 4';
                    const cmdEl = Array.from(document.querySelectorAll('strong')).find((el) =>
                        (el.innerText || '').includes('TOBACCO / WRAP AROUND'),
                    );
                    if (cmdEl && cmdOwner) cmdEl.innerText = `${cmdLabel}: TOBACCO / WRAP AROUND (${cmdOwner})`;
                } catch (_) { /* ignore */ }
            }

            renderFifoAislePanel(s);
            applyDisplayToggleGuards(data);

            patchTvFloorMapColors(s);

            if (s.Zone_Section_Labels) {
                try {
                    const labels = JSON.parse(s.Zone_Section_Labels);
                    Object.entries(labels).forEach(([id, cfg]) => {
                        const el = document.getElementById(id);
                        if (!el) return;
                        if (id === 'map-a5' && ZC?.applyA5JointStyle) {
                            const pri = ZC.mapSectionPriorityClass?.('A5', data?.tasks || []) || '';
                            const pulse = pri === 'map-priority-urgent' ? 'urgent'
                                : pri === 'map-priority-high' ? 'high'
                                    : pri === 'map-priority-active' ? 'active'
                                        : '';
                            ZC.applyA5JointStyle(el, cfg, false, pulse);
                            return;
                        }
                        const strong = el.querySelector('strong');
                        const small = el.querySelector('small');
                        if (strong && cfg.label) strong.innerText = cfg.label;
                        if (small && cfg.sublabel) small.innerText = cfg.sublabel;
                    });
                } catch (_) { /* ignore */ }
            }
        } catch (e) {
            console.error('TV Style Injection Failed', e);
        }
    }

    async function applySettings() {
        ensureStreamStatusBadge();
        const data = await applyTvSync();
        if (!data) return;
        await applyLayoutFromData(data);
    }

    let streamHandle = null;

    function onPushEvent() {
        window.dispatchEvent(new CustomEvent('tgp-push'));
        if (!window.TgpTvNative) void applySettings();
    }

    function connectTvStream() {
        if (typeof TgpStream === 'undefined' || window.TgpTvNative) return;
        if (streamHandle) streamHandle.close();
        streamHandle = TgpStream.connect({
            onEvent(m) {
                if (m?.type === 'REFRESH' || m?.type === 'DELTA') onPushEvent();
            },
            onOpen() {
                streamLive = true;
                updateStreamStatusBadge();
            },
            onError() {
                streamLive = false;
                updateStreamStatusBadge();
            },
        });
    }

    ensureStreamStatusBadge();
    if (window.TgpTvNative) {
        window.addEventListener('tgp-tv-sync', (e) => {
            if (e.detail?.ts) lastSyncOk = e.detail.ts;
            updateStreamStatusBadge();
        });
        window.addEventListener('tgp-tv-stream', (e) => {
            streamLive = !!e.detail?.live;
            updateStreamStatusBadge();
        });
    } else {
        applySettings();
        connectTvStream();
        setInterval(applySettings, 90000);
    }
    setInterval(updateStreamStatusBadge, 15000);
    window.addEventListener('tgp-native-rendered', (e) => {
        if (!e.detail) return;
        applyNativeTvOverlays(e.detail);
        void applyLayoutFromData(e.detail);
    });
    window.addEventListener('message', (e) => {
        if (e.data === 'force-refresh') onPushEvent();
    });
})();
