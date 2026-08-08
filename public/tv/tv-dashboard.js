/**
 * TGP native TV dashboard — readable source in repo.
 * Renders from GET /api/sync; tv-overrides.js adds expiry panels, layout, SSE.
 */
(function () {
    'use strict';

    const DEVICE_TOKEN_KEY = 'tgp.tv.deviceToken';
    let storeTimezone = 'America/Toronto';

    function readDeviceToken() {
        try { return window.localStorage.getItem(DEVICE_TOKEN_KEY) || ''; } catch (_) { return ''; }
    }

    function storeDeviceTokenFromUrl() {
        try {
            const url = new URL(window.location.href);
            const hashParams = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : '');
            const token = hashParams.get('deviceToken') || '';
            if (!token) return;
            window.localStorage.setItem(DEVICE_TOKEN_KEY, token);
            hashParams.delete('deviceToken');
            const remainingHash = hashParams.toString();
            url.hash = remainingHash ? `#${remainingHash}` : '';
            window.history.replaceState(
                {},
                document.title,
                `${url.pathname}${url.search}${url.hash}`,
            );
        } catch (_) { /* localStorage/history may be blocked */ }
    }

    const esc = (v) => String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    function settingEnabled(settings, key, defaultValue = true) {
        const raw = settings ? settings[key] : undefined;
        if (raw === undefined || raw === null || raw === '') return !!defaultValue;
        if (typeof raw === 'boolean') return raw;
        if (typeof raw === 'number') return raw !== 0;
        return !/^(0|false|off|no)$/i.test(String(raw).trim());
    }

    function tvDisplayPrefs(data) {
        if (data?.tv_display && typeof data.tv_display === 'object') {
            return {
                showPinnedDailyHuddle: data.tv_display.showPinnedDailyHuddle !== false,
                showStoreComms: data.tv_display.showStoreComms !== false,
                showAuditTrail: data.tv_display.showAuditTrail !== false,
                showTicker: data.tv_display.showTicker !== false,
                showLatestShiftUpdate: data.tv_display.showLatestShiftUpdate !== false,
            };
        }
        const settings = data?.settings || {};
        return {
            showPinnedDailyHuddle: settingEnabled(settings, 'TV_Show_Pinned_Daily_Huddle', false),
            showStoreComms: settingEnabled(settings, 'TV_Show_Store_Comms', true),
            showAuditTrail: settingEnabled(settings, 'TV_Show_Audit_Trail', true),
            showTicker: settingEnabled(settings, 'TV_Show_Ticker', false),
            showLatestShiftUpdate: settingEnabled(settings, 'TV_Show_Latest_Shift_Update', false),
        };
    }

    function applyTvDisplayPrefsToDom(data) {
        const prefs = tvDisplayPrefs(data);
        if (!document?.body) return prefs;
        document.body.dataset.tvShowPinnedDailyHuddle = prefs.showPinnedDailyHuddle ? '1' : '0';
        document.body.dataset.tvShowStoreComms = prefs.showStoreComms ? '1' : '0';
        document.body.dataset.tvShowAuditTrail = prefs.showAuditTrail ? '1' : '0';
        document.body.dataset.tvShowTicker = prefs.showTicker ? '1' : '0';
        document.body.dataset.tvShowLatestShiftUpdate = prefs.showLatestShiftUpdate ? '1' : '0';

        // Store Comms no longer controls the Daily Direction box. Daily Direction
        // is its own floor-facing operating control and should remain visible once posted.
        if (!prefs.showTicker) {
            const wrap = document.getElementById('tv-ticker-wrap');
            const tick = document.getElementById('tv-ticker');
            if (wrap) wrap.style.display = 'none';
            if (tick) tick.textContent = '';
        }
        return prefs;
    }

    function commsKind(msg) {
        return String(msg?.meta?.kind || msg?.meta?.type || '').trim().toLowerCase();
    }

    function commsDedupe(msg) {
        return String(msg?.dedupe_key || '').trim().toLowerCase();
    }

    function isDailyHuddleMessage(msg) {
        const kind = commsKind(msg);
        const dedupe = commsDedupe(msg);
        return kind === 'daily_direction'
            || kind === 'daily_direction_floor'
            || dedupe.startsWith('daily-direction:');
    }

    function isShiftUpdateMessage(msg) {
        const kind = commsKind(msg);
        const dedupe = commsDedupe(msg);
        return kind === 'shift_update'
            || kind === 'daily_direction_shift_update'
            || dedupe.startsWith('shift-update:')
            || dedupe.startsWith('daily-direction-shift-update:');
    }

    function isAuditTrailMessage(msg) {
        const kind = commsKind(msg);
        const dedupe = commsDedupe(msg);
        const source = String(msg?.source || '').trim().toLowerCase();
        const lane = String(msg?.lane || '').trim().toLowerCase();
        return source === 'system'
            || source === 'auto'
            || lane === 'audit'
            || kind === 'audit'
            || kind.startsWith('system')
            || dedupe.startsWith('system:');
    }

    const ZONE_TO_SECTIONS = {
        Dairy: ['Dairy'], Bakery: ['Bakery'], Produce: ['Produce'], Freezer: ['Freezer'],
        A1: ['A1'], A2: ['A2'], A3: ['A3'], A4: ['A4'],
        A5: ['A5'], A6: ['A6'], A7: ['A7'], A8: ['A8'],
        Pop: ['Pop'], Water: ['Water'], Jerry: ['Jerry'], Seasonal: ['Seasonal'],
        General: [],
        'Zone 1': ['Dairy', 'Bakery', 'Produce', 'Freezer', 'Pop'],
        'Zone 2': ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'],
        'Zone 3': ['Pop', 'Water', 'Jerry', 'Seasonal'],
    };

    let mapSections = [];

    function sortTasksForBoard(tasks) {
        const pri = { Urgent: 0, High: 1 };
        return [...(tasks || [])].sort((a, b) => {
            const aPull = String(a.task_detail || '').startsWith('PULL:') ? 0 : 1;
            const bPull = String(b.task_detail || '').startsWith('PULL:') ? 0 : 1;
            if (aPull !== bPull) return aPull - bPull;
            return (pri[a.priority] ?? 2) - (pri[b.priority] ?? 2);
        });
    }

    function renderFifoAisleAssignments(settings) {
        const panel = document.getElementById('tv-fifo-aisle-assignments');
        if (!panel) return;
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

    function taskCard(t, extraClass) {
        const pri = t.priority === 'Urgent' ? 'urgent' : t.priority === 'High' ? 'high' : '';
        const cls = ['card', pri, extraClass || ''].filter(Boolean).join(' ');
        const meta = t.assigned_to || 'Unassigned';
        return `<div class="${cls}">
            <div><span class="card-zone">${esc(t.zone || 'General')}</span> ${esc(t.task_detail || '')}</div>
            <div class="card-meta card-meta-assignee">${esc(meta)}</div>
        </div>`;
    }

    function tasksForSection(sectionId, tasks) {
        return tasks.filter((t) => {
            const z = t.zone || 'General';
            if (z === 'General') return false;
            if (z === sectionId) return true;
            const sections = ZONE_TO_SECTIONS[z];
            return sections && sections.includes(sectionId);
        });
    }

    function mapSectionClass(sectionId, tasks) {
        const matched = tasksForSection(sectionId, tasks);
        if (!matched.length) return 'default';
        if (matched.some((t) => t.priority === 'Urgent' || String(t.task_detail || '').startsWith('PULL:'))) return 'urgent';
        if (matched.some((t) => t.priority === 'High')) return 'high';
        return 'active';
    }

    function mapLabelMarkup(sec, cfg, label, labelY, color, matched) {
        const cx = Math.round(sec.x + sec.w / 2);
        const sub = cfg.sublabel || '';
        const hasBadge = matched.length > 0;
        const mainY = Math.round(sub && hasBadge ? labelY - 8 : labelY);
        const subY = Math.round(mainY + 18);
        const main = `<text x="${cx}" y="${mainY}" text-anchor="middle" dominant-baseline="middle" class="zone-label" fill="${color}">${esc(label)}</text>`;
        const subText = sub
            ? `<text x="${cx}" y="${subY}" text-anchor="middle" dominant-baseline="middle" class="zone-sublabel" fill="#b8c8d8">${esc(sub)}</text>`
            : '';
        return main + subText;
    }

    const ZONE_COLORS = window.TgpZoneColors?.ZONE_COLORS || {
        'Zone 1': '#f90', 'Zone 2': '#0f8', 'Zone 3': '#0cf', 'Zone 4': '#f44', COMMAND: '#f44',
    };
    const colorForZone = window.TgpZoneColors?.colorForZone
        || ((zone) => (zone && ZONE_COLORS[zone] ? ZONE_COLORS[zone] : '#a855f7'));
    const colorForSection = window.TgpZoneColors?.colorForSection
        || ((sectionId, zone) => colorForZone(zone));
    const sectionColorZoneMap = window.TgpZoneColors?.sectionColorZoneMap
        || (() => ({}));

    function sectionToZoneMap(settings) {
        const out = {};
        Object.entries(ZONE_TO_SECTIONS).forEach(([zone, sections]) => {
            sections.forEach((id) => { out[id] = zone; });
        });
        if (!settings?.Zone_Mapping) return out;
        try {
            const mapping = JSON.parse(settings.Zone_Mapping);
            Object.entries(mapping).forEach(([zone, ids]) => {
                ids.forEach((id) => {
                    const alias = id.replace(/^map-/, '').replace(/^a(\d)$/i, 'A$1');
                    out[alias] = zone;
                    out[id] = zone;
                });
            });
        } catch (_) { /* ignore */ }
        return out;
    }

    function renderMap(tasks, sectionLabels, settings) {
        const svg = document.getElementById('tv-map-svg');
        if (!svg || !mapSections.length) return;
        const labels = sectionLabels || {};
        const secToZone = sectionColorZoneMap(settings || {});
        const a5Outline = window.TgpZoneColors?.a5SegmentedOutlineSvg;
        const a5Fill = window.TgpZoneColors?.a5SegmentedFillSvg;
        const a5Cols = window.TgpZoneColors?.A5_SECTION_COLORS || ['#f90', '#0cf', '#0f8'];
        svg.innerHTML = `<g id="map-geometry">${mapSections.map((sec) => {
            const cfg = labels[sec.id] || labels[`map-${sec.id.toLowerCase()}`] || {};
            const label = cfg.label || sec.label || sec.id;
            const matched = tasksForSection(sec.id, tasks);
            const cls = mapSectionClass(sec.id, tasks);
            const zone = secToZone[sec.id];
            const hasUrgent = matched.some((t) => t.priority === 'Urgent' || String(t.task_detail || '').startsWith('PULL:'));
            const labelY = sec.y + (matched.length ? sec.h / 2 - 4 : sec.h / 2 + 8);

            if (sec.id === 'A5') {
                const color = a5Cols[0];
                const badgeFill = hasUrgent ? '#f44' : color;
                const badgeClass = hasUrgent ? 'task-badge task-badge-urgent' : 'task-badge';
                const badge = matched.length
                    ? `<g class="${badgeClass}"><circle cx="${sec.x + sec.w / 2}" cy="${sec.y + sec.h / 2 + 18}" r="12" fill="${badgeFill}"/><text x="${sec.x + sec.w / 2}" y="${sec.y + sec.h / 2 + 19}" text-anchor="middle" dominant-baseline="middle" fill="${hasUrgent ? '#fff' : '#000'}" font-size="14" font-weight="bold" style="stroke:none">${matched.length}</text></g>`
                    : '';
                const outline = a5Outline
                    ? a5Outline(sec.x, sec.y, sec.w, sec.h, 1.5, a5Cols)
                    : '';
                const fill = a5Fill
                    ? a5Fill(sec.x, sec.y, sec.w, sec.h, a5Cols, { alpha: 0.16 })
                    : '';
                const triPulse = matched.length && cls !== 'default' ? ` a5-tri-${cls}` : '';
                return `<g id="${esc(sec.id)}">
                    <g class="zone-block a5-tri${triPulse}${matched.length ? ` ${cls}` : ''}">
                        ${fill}
                        ${outline}
                        ${badge}
                    </g>
                    ${mapLabelMarkup(sec, cfg, label, labelY, color, matched)}
                </g>`;
            }

            const color = colorForSection(sec.id, zone);
            const fill = window.TgpZoneColors?.rgbaHex
                ? window.TgpZoneColors.rgbaHex(color, 0.16)
                : `${color}28`;
            const badgeFill = hasUrgent ? '#f44' : color;
            const badgeClass = hasUrgent ? 'task-badge task-badge-urgent' : 'task-badge';
            const badge = matched.length
                ? `<g class="${badgeClass}"><circle cx="${sec.x + sec.w / 2}" cy="${sec.y + sec.h / 2 + 18}" r="12" fill="${badgeFill}"/><text x="${sec.x + sec.w / 2}" y="${sec.y + sec.h / 2 + 19}" text-anchor="middle" dominant-baseline="middle" fill="${hasUrgent ? '#fff' : '#000'}" font-size="14" font-weight="bold" style="stroke:none">${matched.length}</text></g>`
                : '';
            return `<g id="${esc(sec.id)}">
                <g class="zone-block ${cls}">
                    <rect x="${sec.x}" y="${sec.y}" width="${sec.w}" height="${sec.h}" rx="4" fill="${fill}" stroke="${color}" stroke-width="1.5"/>
                    ${badge}
                </g>
                ${mapLabelMarkup(sec, cfg, label, labelY, color, matched)}
            </g>`;
        }).join('')}</g>`;
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

    function isTgpExpectedToday(data) {
        // Source of truth for TGP order days is the fixed store calendar:
        // Sunday, Tuesday, Thursday. Receiving/vendor rows are operational context only.
        const today = normalizeWeekday(data?.storeWeekday) || weekdayFromDateStamp(data?.storeDate);
        return TGP_ORDER_WEEKDAYS.has(today);
    }

    function shouldShowFullOrderKpis(data) {
        const k = data?.kpis || {};
        return !!(k.shift_active || k.shift_done || isTgpExpectedToday(data));
    }

    function renderOrderSizeChip(k, data) {
        const total = Number(k.g || 0) + Number(k.f || 0) + Number(k.h || 0);
        const label = isTgpExpectedToday(data) ? 'TGP TODAY' : 'ORDER SIZE';
        const value = total > 0 ? `${total} pcs` : '—';
        return `<div class="kpi-tile kpi-order-size-chip"><div class="kpi-tile-label">${esc(label)}</div><div class="kpi-tile-value">${esc(value)}</div></div>`;
    }

    function renderKpis(data) {
        const el = document.getElementById('tv-kpis');
        if (!el) return;
        const k = data.kpis || {};
        if (!shouldShowFullOrderKpis(data)) {
            el.classList.add('tv-kpis-compact');
            el.innerHTML = renderOrderSizeChip(k, data);
            return;
        }
        el.classList.remove('tv-kpis-compact');
        const pph = k.shift_active && k.shift_pph != null ? k.shift_pph : (k.shift_pph_final != null ? k.shift_pph_final : '—');
        const pphColor = k.shift_active && k.shift_pph != null && k.shift_pph < (k.shift_standard_pph || 55) ? '#f90' : '';
        el.innerHTML = `
            <div class="kpi-tile"><div class="kpi-tile-label">GROCERY</div><div class="kpi-tile-value">${esc(k.g ?? 0)}</div></div>
            <div class="kpi-tile"><div class="kpi-tile-label">FREEZER</div><div class="kpi-tile-value">${esc(k.f ?? 0)}</div></div>
            <div class="kpi-tile"><div class="kpi-tile-label">HARDWARE</div><div class="kpi-tile-value">${esc(k.h ?? 0)}</div></div>
            <div class="kpi-tile ${k.shift_active ? 'warning' : ''}"><div class="kpi-tile-label">${k.shift_active ? 'ACTUAL PPH' : 'PPH'}</div><div class="kpi-tile-value" style="color:${pphColor}">${esc(pph)}</div></div>
            <div class="kpi-tile"><div class="kpi-tile-label">${k.shift_active ? 'STAFF ON ORDER' : 'STAFF'}</div><div class="kpi-tile-value">${esc(k.order_staff != null ? k.order_staff : k.staff ?? 0)}</div></div>
        `;
    }

    function isPullTask(t) {
        const id = String(t.task_id || '');
        const detail = String(t.task_detail || '');
        return id.startsWith('AUTO-PULL') || detail.startsWith('PULL:');
    }

    const SAFETY_PATTERN = /\b(safety|safe|spill|wet\s*floor|leak|hazard|glass|broken|blocked|exit|fire|injury|first\s*aid|chemical|ladder|trip|fall|cleanup|clean\s*up|dock\s*door)\b/i;

    function isOpenTask(t) {
        return !/^(closed|done|complete|completed)$/i.test(String(t.status || 'Open').trim());
    }

    function isSafetyTask(t) {
        const haystack = `${t.task_detail || ''} ${t.zone || ''} ${t.priority || ''}`;
        return isOpenTask(t) && SAFETY_PATTERN.test(haystack);
    }

    function safetyTaskRank(t) {
        if (t.priority === 'Urgent') return 0;
        if (t.priority === 'High') return 1;
        return 2;
    }

    function renderSafetyPanel(data) {
        const tasks = (data.tasks || [])
            .filter(isSafetyTask)
            .sort((a, b) => safetyTaskRank(a) - safetyTaskRank(b));
        const settings = data.settings || {};
        const focus = data.daily_safety_focus || data.safety_focus || null;
        const focusMessage = String(focus?.message || '').trim();
        const message = String(settings.TV_Safety_Message || settings.Safety_Message || '').trim();
        const cards = [];

        if (focusMessage) {
            cards.push(`<div class="tv-safety-card tv-safety-message">
                <div class="tv-safety-status">TODAY'S SAFETY FOCUS</div>
                <div>${esc(focusMessage)}</div>
            </div>`);
        }

        if (message) {
            cards.push(`<div class="tv-safety-card tv-safety-message">
                <div class="tv-safety-status">SAFETY MESSAGE</div>
                <div>${esc(message)}</div>
            </div>`);
        }

        if (tasks.length) {
            cards.push(...tasks.slice(0, 4).map((t) => `<div class="card urgent tv-safety-task">
                <div><span class="card-zone">${esc(t.zone || 'Safety')}</span> ${esc(t.task_detail || '')}</div>
                <div class="card-meta card-meta-assignee">${esc(t.assigned_to || 'Unassigned')}</div>
            </div>`));
            if (tasks.length > 4) {
                cards.push(`<div class="tv-safety-more">+${tasks.length - 4} more safety item(s) on the task board</div>`);
            }
        }

        if (!cards.length) {
            cards.push(`<div class="tv-safety-card tv-safety-clear">
                <div class="tv-safety-status">ALL CLEAR</div>
                <div class="card-meta">No safety blockers logged on the task board.</div>
            </div>`);
        }

        return `<div class="section-header tv-safety-header">SAFETY WATCH</div>
            <div class="tv-safety-panel ${tasks.length ? 'tv-safety-alert' : 'tv-safety-ok'}">
                ${cards.join('')}
            </div>`;
    }

    function filterTvCommsFeed(feed, pinned, prefs = {}) {
        return (feed || []).filter((m) => {
            const kind = commsKind(m);
            const dedupe = commsDedupe(m);
            if (kind === 'pull_today' || dedupe.startsWith('system:pull-today:')) return false;
            // Daily Direction and its Shift Updates now render only in the Daily Direction box.
            if (isDailyHuddleMessage(m) || isShiftUpdateMessage(m)) return false;
            if (kind === 'daily_direction_floor' || dedupe.startsWith('daily-direction-feed:')) return false;
            if (!prefs.showAuditTrail && isAuditTrailMessage(m)) return false;
            return true;
        });
    }

    function fmtIsoShort(iso) {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return String(iso).slice(11, 16);
            return new Intl.DateTimeFormat('en-US', {
                timeZone: storeTimezone || 'America/Toronto',
                hour: 'numeric',
                minute: '2-digit',
            }).format(d);
        } catch (_) {
            return String(iso).slice(11, 16);
        }
    }

    function dailyDirectionMustWinText(win) {
        if (typeof win === 'string') return win.trim();
        return String(win?.text || '').trim();
    }

    function isDailyDirectionFloorPosted(floor) {
        return !!(floor?.daily_direction?.posted_at || floor?.posted_at);
    }

    function normalizeDailyDirectionText(message, status) {
        const text = String(message || '');
        const normalizedStatus = ['GREEN', 'YELLOW', 'RED'].includes(String(status || '').toUpperCase())
            ? String(status).toUpperCase()
            : 'YELLOW';
        return text.replace(/^TODAY:\s*(GREEN|YELLOW|RED)\b/i, `TODAY: ${normalizedStatus}`);
    }

    function renderDailyDirectionCommsBox(floor) {
        const dd = floor?.daily_direction || floor || {};
        const mustWins = (dd.must_wins || floor?.must_wins || [])
            .map(dailyDirectionMustWinText)
            .filter(Boolean)
            .slice(0, 3);

        const statusRaw = String(dd.status || floor?.status || 'yellow').toLowerCase();
        const status = ['green', 'yellow', 'red'].includes(statusRaw) ? statusRaw : 'yellow';
        const statusColor = dd.status_color || floor?.status_color
            || ({ green: '#0f8', yellow: '#fa0', red: '#f44' }[status]);
        const postedAt = dd.posted_at || floor?.posted_at;
        const postedBy = dd.posted_by || floor?.posted_by || '';
        const updatedAt = dd.updated_at || floor?.updated_at || postedAt;
        const updatedBy = dd.updated_by || floor?.updated_by || postedBy;
        const updateCount = Number(dd.update_count || floor?.update_count || 0);
        const metaLabel = updateCount > 0
            ? `Updated ${esc(fmtIsoShort(updatedAt))}${updatedBy ? ` by ${esc(updatedBy)}` : ''}`
            : `Posted ${esc(fmtIsoShort(postedAt))}${postedBy ? ` by ${esc(postedBy)}` : ''}`;
        const body = normalizeDailyDirectionText(dd.floor_message || floor?.floor_message || '', status);

        return `<div class="comms-feed-item daily-direction-main dd-status-${esc(status)}" style="--dd-status:${esc(statusColor)}">
            <div class="comms-feed-meta daily-direction-label">DAILY DIRECTION · ${esc(status.toUpperCase())}</div>
            <div class="comms-feed-body daily-direction-body">${esc(body)}</div>
            ${mustWins.length ? `<div class="comms-feed-meta daily-direction-must-wins">Must-win: ${mustWins.map(esc).join(' · ')}</div>` : ''}
            <div class="comms-feed-meta">${metaLabel}</div>
        </div>`;
    }

    function renderCenter(tasks) {
        const el = document.getElementById('tv-col-center');
        if (!el) return;
        const open = sortTasksForBoard(tasks).filter((t) => !isPullTask(t));
        el.innerHTML = `<div class="section-header">TASKS</div>` +
            (open.length
                ? open.map((t) => taskCard(t, '')).join('')
                : '<div class="card"><div>No open tasks on the board.</div></div>');
    }

    function renderCommsPinned(data) {
        const el = document.getElementById('tv-comms-pinned');
        if (!el) return;
        const comms = data.comms || {};
        const prefs = tvDisplayPrefs(data);
        if (!comms.enabled || !window.TgpCommsCenter) {
            el.style.display = 'none';
            el.innerHTML = '';
            return;
        }
        const pinned = (comms.pinned || []).filter((m) => {
            // Daily Direction is no longer shown as a top-of-screen pinned banner.
            if (isDailyHuddleMessage(m) || isShiftUpdateMessage(m)) return false;
            if (!prefs.showAuditTrail && isAuditTrailMessage(m)) return false;
            return true;
        });
        if (!pinned.length) {
            el.style.display = 'none';
            el.innerHTML = '';
            return;
        }
        el.style.display = 'block';
        el.innerHTML = pinned.map((m) => {
            const isDaily = isDailyHuddleMessage(m);
            const label = isDaily ? 'DAILY HUDDLE' : (m.priority === 'urgent' ? 'CRITICAL' : 'PINNED');
            const urgent = m.priority === 'urgent';
            const chip = window.TgpCommsCenter.zoneChip(m.zone);
            return `<div class="comms-pinned ${urgent ? 'comms-pinned-urgent' : 'comms-pinned-warn'}">
                <span class="comms-pinned-label">${esc(label)}</span>
                <span class="comms-pinned-body">${chip}${esc(m.body)}</span>
                <span class="comms-pinned-by">${esc(m.posted_by || '')}</span>
            </div>`;
        }).join('');
    }

    function ensureDailyDirectionTopHost() {
        const leftCol = document.querySelector('.col.col-left') || document.querySelector('.col-left');
        if (!leftCol) return null;
        leftCol.classList.add('tv-has-daily-direction-top');
        let section = document.getElementById('tv-comms-section');
        if (!section) {
            section = document.createElement('div');
            section.id = 'tv-comms-section';
            section.className = 'tv-floor-comms-section tv-daily-direction-top-section';
            section.innerHTML = `
                <div class="section-header tv-floor-comms-header" id="tv-comms-header">DAILY DIRECTION</div>
                <div id="tv-comms-feed" class="tv-floor-comms-block tv-daily-direction-top-block"></div>`;
        }
        if (section.parentElement !== leftCol) {
            leftCol.insertBefore(section, leftCol.firstChild);
        } else if (leftCol.firstChild !== section) {
            leftCol.insertBefore(section, leftCol.firstChild);
        }
        return section;
    }

    function renderCommsFeed(data) {
        const prefs = tvDisplayPrefs(data);
        const floor = data.daily_direction_floor || null;
        const posted = isDailyDirectionFloorPosted(floor);
        const existingSection = document.getElementById('tv-comms-section');
        const section = posted ? ensureDailyDirectionTopHost() : existingSection;
        const el = document.getElementById('tv-comms-feed');
        if (!section || !el) return;

        if (!posted) {
            section.style.display = 'none';
            el.innerHTML = '';
            document.querySelector('.col.col-left')?.classList.remove('tv-has-daily-direction-top');
            return;
        }

        const header = document.getElementById('tv-comms-header') || section.querySelector('.tv-floor-comms-header');
        if (header) header.textContent = 'DAILY DIRECTION';

        const dd = floor?.daily_direction || floor || {};
        const statusRaw = String(dd.status || floor?.status || 'yellow').toLowerCase();
        const status = ['green', 'yellow', 'red'].includes(statusRaw) ? statusRaw : 'yellow';
        const statusColor = dd.status_color || floor?.status_color
            || ({ green: '#0f8', yellow: '#fa0', red: '#f44' }[status]);
        section.classList.remove('dd-status-green', 'dd-status-yellow', 'dd-status-red');
        section.classList.add(`dd-status-${status}`);
        section.style.setProperty('--dd-status', statusColor);

        section.style.display = 'block';
        el.innerHTML = renderDailyDirectionCommsBox(floor);
    }

    function renderCommsTicker(data) {
        const comms = data.comms || {};
        const prefs = tvDisplayPrefs(data);
        if (!prefs.showTicker) return [];
        if (!comms.enabled || !window.TgpCommsCenter) return (data.ticker || []).map((t) => t.message || t.note || '').filter(Boolean);
        return filterTvCommsFeed(comms.ticker, comms.pinned, prefs).map((m) => {
            const z = m.zone && m.zone !== 'General' ? `[${m.zone}] ` : '';
            return `${z}${m.body || ''}`;
        }).filter(Boolean);
    }

    function renderRight(data) {
        const el = document.getElementById('tv-col-right-secondary');
        if (!el) return;
        const orders = Array.isArray(data.orders_tv) ? data.orders_tv : [];
        let html = '';
        html += `<div class="tv-customer-orders-section">
            <div class="section-header tv-customer-orders-header">CUSTOMER ORDERS</div>
            <div class="tv-customer-orders-list">`;
        html += orders.length
            ? orders.slice(0, 6).map((o) =>
                `<div class="card tv-customer-orders-block"><div><span class="card-zone">${esc(o.location || '—')}</span> ${esc(o.item || '')}</div></div>`,
            ).join('')
            : '<div class="card tv-customer-orders-block"><div class="card-meta">NO PENDING ORDERS</div></div>';
        html += `</div></div>`;
        html += renderSafetyPanel(data);
        el.innerHTML = html;
    }

    function renderTicker(data) {
        const wrap = document.getElementById('tv-ticker-wrap');
        const tick = document.getElementById('tv-ticker');
        if (!wrap || !tick) return;
        const prefs = tvDisplayPrefs(data);
        if (!prefs.showTicker) {
            wrap.style.display = 'none';
            tick.textContent = '';
            return;
        }
        const comms = data.comms || {};
        let parts = [];
        if (comms.enabled && window.TgpCommsCenter) {
            parts = renderCommsTicker(data);
            const text = window.TgpCommsCenter.tickerText(parts.map((body) => ({ body })));
            if (!text) {
                wrap.style.display = 'none';
                return;
            }
            wrap.style.display = 'block';
            tick.textContent = text.toUpperCase();
            return;
        }
        parts = (data.ticker || []).map((t) => t.message || t.note || '').filter(Boolean);
        const text = parts.join('   ·   ');
        if (!text) {
            wrap.style.display = 'none';
            return;
        }
        wrap.style.display = 'block';
        tick.textContent = text.toUpperCase();
    }

    function renderTitle(data) {
        const el = document.getElementById('tv-store-title');
        if (!el) return;
        const name = data.settings?.Store_Display_Name || data.store?.displayName || 'TGP CENTER STORE';
        el.textContent = String(name).toUpperCase();
    }

    function sectionLabelsFromSettings(settings) {
        const out = {};
        if (!settings?.Zone_Section_Labels) return out;
        try {
            const raw = JSON.parse(settings.Zone_Section_Labels);
            Object.entries(raw).forEach(([key, cfg]) => {
                const alias = key.replace(/^map-/, '').replace(/^a(\d)$/i, 'A$1');
                out[alias] = cfg;
                out[key] = cfg;
            });
        } catch (_) { /* ignore */ }
        return out;
    }

    function renderPresenceStrip(data) {
        let el = document.getElementById('tv-presence-strip');
        if (!el) {
            const header = document.querySelector('.header');
            if (!header) return;
            el = document.createElement('div');
            el.id = 'tv-presence-strip';
            el.className = 'tv-presence-strip';
            header.appendChild(el);
        }
        const p = data.presence_tv;
        if (!p) {
            el.style.display = 'none';
            return;
        }
        el.style.display = 'flex';
        const occ = (p.zone_occupancy || []).slice(0, 4).map((z) => `${esc(z.zone_key)}:${z.count}`).join(' · ');
        const hint = p.order_hint?.count_label || (p.order_hint ? `Recv ${p.order_hint.beacon_count}` : '');
        el.innerHTML = `<span class="tv-presence-label">PRESENCE</span>
            <span>${esc(hint || '—')}</span>
            <span>${esc(occ || '')}</span>
            ${p.offline_count ? `<span class="tv-presence-warn">${p.offline_count} GW OFFLINE</span>` : ''}`;
    }

    function renderDashboard(data) {
        if (data?.storeTimezone) storeTimezone = data.storeTimezone;
        else if (data?.store?.timezone) storeTimezone = data.store.timezone;
        applyTvDisplayPrefsToDom(data);
        renderTitle(data);
        renderKpis(data);
        renderPresenceStrip(data);
        renderCommsPinned(data);
        renderFifoAisleAssignments(data.settings);
        renderMap(data.tasks || [], sectionLabelsFromSettings(data.settings), data.settings);
        renderCommsFeed(data);
        renderCenter(data.tasks || []);
        renderRight(data);
        renderTicker(data);
    }

    async function loadMapSections() {
        try {
            const res = await fetch('/public/tv/map-sections.json');
            if (res.ok) mapSections = await res.json();
        } catch (_) { /* ignore */ }
    }

    function showPairingRequired() {
        streamHandle?.close();
        streamHandle = null;
        streamLive = false;
        if (document?.body) document.body.dataset.tvPairingRequired = '1';
        const title = document.getElementById('tv-store-title');
        if (title) title.textContent = 'PAIRING REQUIRED';
        for (const id of [
            'tv-kpis',
            'tv-presence-strip',
            'tv-comms-pinned',
            'tv-comms-feed',
            'tv-map-svg',
            'tv-col-right-secondary',
            'tv-ticker',
        ]) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        }
        const center = document.getElementById('tv-col-center');
        if (center) {
            center.innerHTML = '<div class="section-header">PAIRING REQUIRED</div><div class="card"><div>No operational data is available until this TV is paired.</div></div>';
        }
        const tickerWrap = document.getElementById('tv-ticker-wrap');
        if (tickerWrap) tickerWrap.style.display = 'none';
    }

    async function refresh() {
        try {
            const deviceToken = readDeviceToken();
            if (!deviceToken) {
                showPairingRequired();
                return false;
            }
            const res = await fetch('/api/sync', { headers: { 'x-device-token': deviceToken } });
            if (!res.ok) {
                showPairingRequired();
                return false;
            }
            const data = await res.json();
            if (data?.syncAudience !== 'tv') {
                showPairingRequired();
                return false;
            }
            if (document?.body) delete document.body.dataset.tvPairingRequired;
            renderDashboard(data);
            window.dispatchEvent(new CustomEvent('tgp-native-rendered', { detail: data }));
            window.dispatchEvent(new CustomEvent('tgp-tv-sync', { detail: { ts: Date.now() } }));
            return true;
        } catch (e) {
            showPairingRequired();
            const msg = String(e?.message || e || '');
            if (/failed to fetch|networkerror|load failed/i.test(msg)) {
                // Rate-limit: refresh + SSE reconnect both hit /api/sync when API is down.
                const now = Date.now();
                if (!window.__tgpTvSyncErrAt || now - window.__tgpTvSyncErrAt > 15000) {
                    window.__tgpTvSyncErrAt = now;
                    console.error('[TV native] API unreachable — is TGP running on :3001?', e);
                }
            } else {
                console.error('[TV native] sync failed', e);
            }
            return false;
        }
    }

    let refreshTimer = null;
    function scheduleRefresh() {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            void refresh();
        }, 250);
    }

    let streamHandle = null;
    let streamLive = false;

    function connectNativeStream() {
        if (typeof TgpStream === 'undefined') return;
        streamHandle?.close();
        streamHandle = TgpStream.connect({
            deviceToken: readDeviceToken(),
            onEvent(m) {
                if (m?.type === 'REFRESH' || m?.type === 'DELTA') scheduleRefresh();
            },
            onOpen() {
                streamLive = true;
                window.dispatchEvent(new CustomEvent('tgp-tv-stream', { detail: { live: true } }));
            },
            onError() {
                streamLive = false;
                window.dispatchEvent(new CustomEvent('tgp-tv-stream', { detail: { live: false } }));
            },
        });
    }

    window.addEventListener('tgp-push', scheduleRefresh);
    window.TgpTvNative = {
        refresh,
        scheduleRefresh,
        streamLive: () => streamLive,
        tvDisplayPrefs,
        applyTvDisplayPrefsToDom,
    };

    (async function init() {
        storeDeviceTokenFromUrl();
        await loadMapSections();
        if (await refresh()) connectNativeStream();
        setInterval(refresh, 120000);
    })();
})();
