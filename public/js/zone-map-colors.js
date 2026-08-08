/**
 * Store map zone hues — keep in sync across mobile, TV dashboard, and TV overrides.
 * Zone 1 orange · Zone 2 green · Zone 3 blue · Zone 4 red · unmapped purple
 * Named floor sections can override zone hue (Pop, Freezer, etc.).
 */
(function (root) {
    'use strict';

    const UNMAPPED = '#a855f7';
    const BLUE = '#0cf';

    const ZONE_COLORS = {
        'Zone 1': '#f90',
        'Zone 2': '#0f8',
        'Zone 3': BLUE,
        'Zone 4': '#f44',
        COMMAND: '#f44',
    };

    /** Legacy default hues when a section has no zone assignment (TV-only tiles). */
    const SECTION_COLORS = {
        Pop: '#0f8',
        Freezer: '#f90',
        Water: '#0f8',
        Seasonal: '#f44',
        Tills: '#f44',
        Bakery: '#f44',
    };

    const SECTION_ID_ALIASES = {
        'map-rfz': 'Pop',
    };

    const ZONE_FILL = {
        'Zone 1': { warm: 'rgba(255,170,0,0.14)', cold: 'rgba(255,170,0,0.07)' },
        'Zone 2': { warm: 'rgba(0,255,136,0.14)', cold: 'rgba(0,255,136,0.07)' },
        'Zone 3': { warm: 'rgba(0,229,255,0.14)', cold: 'rgba(0,229,255,0.07)' },
        'Zone 4': { warm: 'rgba(255,68,68,0.14)', cold: 'rgba(255,68,68,0.07)' },
        COMMAND: { warm: 'rgba(255,68,68,0.14)', cold: 'rgba(255,68,68,0.07)' },
        unmapped: { warm: 'rgba(168,85,247,0.14)', cold: 'rgba(168,85,247,0.07)' },
    };

    function fillFromHex(hex, isCold) {
        const a = isCold ? 0.07 : 0.14;
        if (hex === '#0f8') return isCold ? 'rgba(0,255,136,0.07)' : 'rgba(0,255,136,0.14)';
        if (hex === '#f90') return isCold ? 'rgba(255,170,0,0.07)' : 'rgba(255,170,0,0.14)';
        if (hex === BLUE) return isCold ? 'rgba(0,229,255,0.07)' : 'rgba(0,229,255,0.14)';
        if (hex === '#f44') return isCold ? 'rgba(255,68,68,0.07)' : 'rgba(255,68,68,0.14)';
        if (hex === UNMAPPED) return isCold ? ZONE_FILL.unmapped.cold : ZONE_FILL.unmapped.warm;
        return isCold ? 'rgba(168,85,247,0.07)' : 'rgba(168,85,247,0.14)';
    }

    const ZONE_TILE = {
        'Zone 1': { bg: 'rgba(255,170,0,0.14)', border: '#f90', text: '#f90' },
        'Zone 2': { bg: 'rgba(0,255,136,0.14)', border: '#0f8', text: '#0f8' },
        'Zone 3': { bg: 'rgba(0,229,255,0.14)', border: BLUE, text: BLUE },
        'Zone 4': { bg: 'rgba(255,68,68,0.14)', border: '#f44', text: '#f44' },
        COMMAND: { bg: 'rgba(255,68,68,0.14)', border: '#f44', text: '#f44' },
        unmapped: { bg: 'rgba(168,85,247,0.14)', border: UNMAPPED, text: UNMAPPED },
    };

    const MAP_SECTION_IDS = [
        'map-a1', 'map-a2', 'map-a3', 'map-a4', 'map-a5', 'map-a6', 'map-a7', 'map-a8',
        'map-rfz', 'map-fsfrz',
    ];

    /** A5 joint ownership: Wraps (Chandler) | Monin/Torani (Luke) | Coffee (Ashley). */
    const A5_SECTION_COLORS = ['#f90', BLUE, '#0f8'];

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

    function normalizeSectionId(sectionId) {
        const bare = String(sectionId || '').replace(/^map-/, '');
        const m = /^a(\d)$/i.exec(bare);
        if (m) return `A${m[1]}`;
        if (bare === 'rfz') return 'Pop';
        if (bare === 'fsfrz') return 'Freezer';
        return bare;
    }

    function tasksForSection(sectionId, tasks) {
        const secId = normalizeSectionId(sectionId);
        return (tasks || []).filter((t) => {
            const z = t.zone || 'General';
            if (z === 'General') return false;
            if (z === secId || z === sectionId) return true;
            const sections = ZONE_TO_SECTIONS[z];
            return sections && sections.includes(secId);
        });
    }

    function sectionHasUrgentTasks(sectionId, tasks) {
        return tasksForSection(sectionId, tasks).some(
            (t) => t.priority === 'Urgent' || String(t.task_detail || '').startsWith('PULL:'),
        );
    }

    /** Matches TV mapSectionClass — urgent > high > active (open tasks). */
    function mapSectionPriorityClass(sectionId, tasks) {
        const matched = tasksForSection(sectionId, tasks);
        if (!matched.length) return '';
        if (matched.some((t) => t.priority === 'Urgent' || String(t.task_detail || '').startsWith('PULL:'))) {
            return 'map-priority-urgent';
        }
        if (matched.some((t) => t.priority === 'High')) return 'map-priority-high';
        return 'map-priority-active';
    }

    function hexToRgb(hex) {
        const h = String(hex).replace('#', '');
        const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
        return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
    }

    function rgbaHex(hex, alpha) {
        const [r, g, b] = hexToRgb(hex);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    /** CSS background layers: tri-color segmented outline, transparent interior. */
    function a5SegmentedBorderCss(colors, linePx = 2) {
        const [orange, blue, green] = colors;
        const px = `${linePx}px`;
        return [
            `linear-gradient(${orange}, ${orange}) 0 0 / 33.33% ${px} no-repeat`,
            `linear-gradient(${blue}, ${blue}) 33.33% 0 / 33.34% ${px} no-repeat`,
            `linear-gradient(${green}, ${green}) 66.66% 0 / 33.33% ${px} no-repeat`,
            `linear-gradient(${orange}, ${orange}) 0 100% / 33.33% ${px} no-repeat`,
            `linear-gradient(${blue}, ${blue}) 33.33% 100% / 33.34% ${px} no-repeat`,
            `linear-gradient(${green}, ${green}) 66.66% 100% / 33.33% ${px} no-repeat`,
            `linear-gradient(${orange}, ${orange}) 0 0 / ${px} 33.33% no-repeat`,
            `linear-gradient(${blue}, ${blue}) 0 33.33% / ${px} 33.34% no-repeat`,
            `linear-gradient(${green}, ${green}) 0 66.66% / ${px} 33.33% no-repeat`,
            `linear-gradient(${orange}, ${orange}) 100% 0 / ${px} 33.33% no-repeat`,
            `linear-gradient(${blue}, ${blue}) 100% 33.33% / ${px} 33.34% no-repeat`,
            `linear-gradient(${green}, ${green}) 100% 66.66% / ${px} 33.33% no-repeat`,
        ].join(', ');
    }

    /** SVG interior — three vertical bands (orange / blue / green), matching other aisle fills. */
    function a5SegmentedFillSvg(x, y, w, h, colors, opts = {}) {
        const { isCold = false, alpha } = opts;
        const fillAlpha = alpha != null ? alpha : (isCold ? 0.07 : 0.14);
        const [orange, blue, green] = colors;
        const tx = w / 3;
        const band = (tone, hex, fx, fw) => `<rect class="a5-fill a5-fill-${tone}" x="${fx}" y="${y}" width="${fw}" height="${h}" fill="${rgbaHex(hex, fillAlpha)}"/>`;
        return [
            band('orange', orange, x, tx),
            band('blue', blue, x + tx, tx),
            band('green', green, x + 2 * tx, w - 2 * tx),
        ].join('');
    }

    /** SVG line segments — orange / blue / green border, no fill. */
    function a5SegmentedOutlineSvg(x, y, w, h, sw, colors) {
        const [orange, blue, green] = colors;
        const tx = w / 3;
        const ty = h / 3;
        const x2 = x + w;
        const y2 = y + h;
        const s = (tone, hex, attrs) => `<line class="a5-seg a5-seg-${tone}" ${attrs} stroke="${hex}" stroke-width="${sw}" stroke-linecap="square" vector-effect="non-scaling-stroke"/>`;
        return [
            s('orange', orange, `x1="${x}" y1="${y}" x2="${x + tx}" y2="${y}"`),
            s('blue', blue, `x1="${x + tx}" y1="${y}" x2="${x + 2 * tx}" y2="${y}"`),
            s('green', green, `x1="${x + 2 * tx}" y1="${y}" x2="${x2}" y2="${y}"`),
            s('orange', orange, `x1="${x}" y1="${y2}" x2="${x + tx}" y2="${y2}"`),
            s('blue', blue, `x1="${x + tx}" y1="${y2}" x2="${x + 2 * tx}" y2="${y2}"`),
            s('green', green, `x1="${x + 2 * tx}" y1="${y2}" x2="${x2}" y2="${y2}"`),
            s('orange', orange, `x1="${x}" y1="${y}" x2="${x}" y2="${y + ty}"`),
            s('blue', blue, `x1="${x}" y1="${y + ty}" x2="${x}" y2="${y + 2 * ty}"`),
            s('green', green, `x1="${x}" y1="${y + 2 * ty}" x2="${x}" y2="${y2}"`),
            s('orange', orange, `x1="${x2}" y1="${y}" x2="${x2}" y2="${y + ty}"`),
            s('blue', blue, `x1="${x2}" y1="${y + ty}" x2="${x2}" y2="${y + 2 * ty}"`),
            s('green', green, `x1="${x2}" y1="${y + 2 * ty}" x2="${x2}" y2="${y2}"`),
        ].join('');
    }

    /** A5: tri-color fill + segmented outline, standard tile label. */
    function applyA5JointStyle(el, a5Cfg, isCold, pulseMode) {
        if (!el) return;
        let pulse = pulseMode;
        if (pulseMode === true) pulse = 'urgent';
        if (pulseMode === false || pulseMode == null) pulse = '';
        const [orange] = A5_SECTION_COLORS;
        const esc = (v) => String(v ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const title = a5Cfg?.label || 'A5';
        const sub = a5Cfg?.sublabel || 'COFFEE';
        const sw = pulse === 'urgent' ? 3 : pulse ? 2.5 : 2;
        el.classList.remove('map-a5-active', 'map-a5-high', 'map-a5-urgent');
        if (pulse) el.classList.add(`map-a5-${pulse}`);
        el.style.position = 'relative';
        el.style.background = 'transparent';
        el.style.backgroundColor = 'transparent';
        el.style.border = 'none';
        el.style.borderImage = 'none';
        el.style.borderRadius = '3px';
        el.style.opacity = isCold ? '0.75' : '1';
        el.style.boxShadow = pulse === 'urgent' ? '0 0 14px rgba(255, 68, 68, 0.55)' : 'none';
        el.style.animation = '';
        const inset = sw * 0.5 + 0.5;
        const inner = 100 - inset * 2;
        const fill = a5SegmentedFillSvg(inset, inset, inner, inner, A5_SECTION_COLORS, { isCold });
        const outline = a5SegmentedOutlineSvg(inset, inset, inner, inner, sw, A5_SECTION_COLORS);
        el.innerHTML = `
            <svg class="map-a5-outline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                ${fill}
                ${outline}
            </svg>
            <span class="map-a5-label">
                <strong style="color:${orange};font-size:1.05em;">${esc(title)}</strong><br/>
                <small style="color:#aaa;font-size:0.92em;">${esc(sub)}</small>
            </span>`;
    }

    function normalizeMapZoneKey(z) {
        if (z === 'COMMAND' || z === 'Command') return 'Zone 4';
        return z;
    }

    function resolveSectionColorKey(sectionId) {
        if (!sectionId) return null;
        if (SECTION_COLORS[sectionId]) return sectionId;
        const alias = SECTION_ID_ALIASES[sectionId];
        if (alias && SECTION_COLORS[alias]) return alias;
        return null;
    }

    function colorForZone(zone) {
        const key = normalizeMapZoneKey(zone);
        return key && ZONE_COLORS[key] ? ZONE_COLORS[key] : UNMAPPED;
    }

    function colorForSection(sectionId, zone) {
        if (zone) return colorForZone(zone);
        const sectionKey = resolveSectionColorKey(sectionId);
        if (sectionKey) return SECTION_COLORS[sectionKey];
        return UNMAPPED;
    }

    function fillForZone(zone, isCold) {
        const key = normalizeMapZoneKey(zone);
        const fills = (key && ZONE_FILL[key]) || ZONE_FILL.unmapped;
        return isCold ? fills.cold : fills.warm;
    }

    function fillForSection(sectionId, zone, isCold) {
        const hex = colorForSection(sectionId, zone);
        if (resolveSectionColorKey(sectionId)) return fillFromHex(hex, isCold);
        return fillForZone(zone, isCold);
    }

    function tileForZone(zone) {
        const key = normalizeMapZoneKey(zone);
        return (key && ZONE_TILE[key]) || ZONE_TILE.unmapped;
    }

    function tileForSection(sectionId, zone) {
        const hex = colorForSection(sectionId, zone);
        return { bg: fillFromHex(hex, false), border: hex, text: hex };
    }

    /** Map config ids (map-a1) and TV SVG ids (A1) from saved Zone_Mapping only. */
    function sectionColorZoneMap(settings) {
        const out = {};
        if (!settings?.Zone_Mapping) return out;
        try {
            const mapping = JSON.parse(settings.Zone_Mapping);
            Object.entries(mapping).forEach(([zone, ids]) => {
                (ids || []).forEach((id) => {
                    out[id] = zone;
                    const bare = String(id).replace(/^map-/, '');
                    out[bare] = zone;
                    const aisleMatch = /^a(\d)$/i.exec(bare);
                    if (aisleMatch) out[`A${aisleMatch[1]}`] = zone;
                    if (bare === 'rfz') out.RFZ = zone;
                    if (bare === 'fsfrz') {
                        out['FS FRZ'] = zone;
                        out.FSFRZ = zone;
                        out.Freezer = zone;
                    }
                    if (bare === 'cmd') {
                        out.COMMAND = zone;
                        out.cmd = zone;
                    }
                });
            });
            /** TV floor: Pop aisle is part of A1 — always share zone/color. */
            const a1Zone = out.A1 || out['map-a1'];
            if (a1Zone) {
                out.A1 = a1Zone;
                out.Pop = a1Zone;
            }
            /** TV floor: Food Srvc sits above Freezer — share FS FRZ / map-fsfrz zone. */
            const freezerZone = out.Freezer || out['map-fsfrz'] || out.FSFRZ;
            if (freezerZone) {
                out.Freezer = freezerZone;
                out['Food Srvc'] = freezerZone;
            }
        } catch (_) { /* ignore */ }
        return out;
    }

    /** TV floor plan section order — must match public/tv/map-sections.json (React shell has no g[id]). */
    const TV_MAP_SECTION_IDS = [
        'Water', 'Jerry', 'Receiving', 'Pop', 'Bakery', 'Tills',
        'A1', 'A2', 'A3', 'A4', 'Food Srvc', 'Freezer', 'Dairy', 'Produce',
        'A5', 'A6', 'A7', 'A8', 'Seasonal',
    ];

    function applyColorToTvMapGroup(g, secId, zone) {
        if (!g || secId === 'A5') return;
        const color = colorForSection(secId, zone);
        const fill = rgbaHex(color, 0.16);
        g.querySelectorAll('rect').forEach((rect) => {
            rect.setAttribute('stroke', color);
            rect.setAttribute('fill', fill);
            rect.style.stroke = color;
            rect.style.fill = fill;
        });
        g.querySelectorAll('text.zone-label').forEach((t) => {
            t.setAttribute('fill', color);
            t.style.fill = color;
        });
    }

    /** Patch TV SVG floor map from saved Zone_Mapping (legacy React shell). Native shell renders in tv-dashboard.js. */
    let tvMapPatching = false;
    function applyTvFloorMapColors(settings, svgRoot) {
        if (!settings || tvMapPatching) return;
        const svg = svgRoot || (typeof document !== 'undefined' ? document.getElementById('tv-map-svg') : null);
        if (!svg) return;
        tvMapPatching = true;
        try {
            const secToZone = sectionColorZoneMap(settings);
            const geometry = svg.querySelector('#map-geometry') || svg;
            const idGroups = Array.from(geometry.children).filter(
                (n) => n.tagName && n.tagName.toLowerCase() === 'g' && n.id,
            );
            if (idGroups.length) {
                idGroups.forEach((g) => applyColorToTvMapGroup(g, g.id, secToZone[g.id]));
                return;
            }
            const childGroups = Array.from(geometry.children).filter(
                (n) => n.tagName && n.tagName.toLowerCase() === 'g',
            );
            TV_MAP_SECTION_IDS.forEach((secId, idx) => {
                applyColorToTvMapGroup(childGroups[idx], secId, secToZone[secId]);
            });
        } finally {
            tvMapPatching = false;
        }
    }

    root.TgpZoneColors = {
        UNMAPPED,
        BLUE,
        ZONE_COLORS,
        SECTION_COLORS,
        ZONE_FILL,
        ZONE_TILE,
        MAP_SECTION_IDS,
        A5_SECTION_COLORS,
        applyA5JointStyle,
        a5SegmentedBorderCss,
        a5SegmentedFillSvg,
        a5SegmentedOutlineSvg,
        rgbaHex,
        normalizeMapZoneKey,
        colorForZone,
        colorForSection,
        fillForZone,
        fillForSection,
        tileForZone,
        tileForSection,
        sectionColorZoneMap,
        TV_MAP_SECTION_IDS,
        applyTvFloorMapColors,
        applyColorToTvMapGroup,
        normalizeSectionId,
        tasksForSection,
        sectionHasUrgentTasks,
        mapSectionPriorityClass,
    };
}(typeof window !== 'undefined' ? window : globalThis));
