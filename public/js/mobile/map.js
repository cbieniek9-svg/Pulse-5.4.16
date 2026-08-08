// ── 7. ZONE MAP ───────────────────────────────────────────────────────────────

function heatMapLastAuditIso(entry) {
    if (!entry) return '';
    if (typeof entry === 'string') return entry;
    if (typeof entry === 'object' && entry.last_audit) return String(entry.last_audit);
    return '';
}

function isHeatMapZoneCold(entry, nowMs, thresholdMs) {
    const iso = heatMapLastAuditIso(entry);
    if (!iso) return true;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return true;
    return (nowMs - t) > thresholdMs;
}

function normalizeMapZoneKey(z) {
    if (z === 'COMMAND' || z === 'Command') return 'Zone 4';
    return z;
}

const MAP_CONFIG_SECTIONS = [
    'map-a1', 'map-a2', 'map-a3', 'map-a4', 'map-a5', 'map-a6', 'map-a7', 'map-a8', 'map-rfz', 'map-fsfrz',
];

/** Prefer live zone dropdowns when editing; otherwise saved Zone_Mapping. */
function resolveZoneMapping(settings) {
    let fromServer = {};
    try { fromServer = JSON.parse(settings?.Zone_Mapping || '{}'); } catch (_) { /* ignore */ }
    const hasUi = MAP_CONFIG_SECTIONS.some((id) => $el(`zsec-${id}`));
    if (!hasUi) return fromServer;

    const mapping = { 'Zone 1': [], 'Zone 2': [], 'Zone 3': [], 'Zone 4': ['map-cmd'] };
    MAP_CONFIG_SECTIONS.forEach((id) => {
        const v = $el(`zsec-${id}`)?.value;
        if (v && mapping[v]) {
            mapping[v].push(id);
            return;
        }
        for (const [z, ids] of Object.entries(fromServer)) {
            if ((ids || []).includes(id) && mapping[z]) {
                mapping[z].push(id);
                break;
            }
        }
    });
    return mapping;
}

/** A5 joint ownership — delegates to TgpZoneColors (soft gradient, standard tile layout). */
function applyA5PremiumMapStyle(a5El, a5Cfg, isCold, isUrgent) {
    if (window.TgpZoneColors?.applyA5JointStyle) {
        window.TgpZoneColors.applyA5JointStyle(a5El, a5Cfg, isCold, isUrgent);
    }
}

function renderFifoAisleAssignments(settings) {
    const panel = $el('fifo-aisle-assignments');
    if (!panel) return;
    let rows = [];
    try { rows = JSON.parse(settings?.FIFO_Aisle_Assignments || '[]'); } catch (_) { /* ignore */ }
    if (!rows.length) {
        panel.innerHTML = '';
        return;
    }
    const sorted = [...rows].sort((a, b) => String(a.staff).localeCompare(String(b.staff)));
    panel.innerHTML = `
        <div style="color:#0f8;font-weight:bold;margin-bottom:6px;letter-spacing:1px;">FIFO AUDIT ASSIGNMENTS</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:4px 10px;">
            ${sorted.map((r) => `<div style="background:rgba(255,255,255,0.04);padding:4px 6px;border-radius:3px;">
                <strong style="color:#fff;">${esc(r.staff)}</strong><br/>
                <small style="color:#8cf;">${esc((r.aisles || []).join(' · '))}</small>
            </div>`).join('')}
        </div>`;
}

function parseFifoAssignments(settings) {
    try {
        const rows = JSON.parse(settings?.FIFO_Aisle_Assignments || '[]');
        return Array.isArray(rows) ? rows : [];
    } catch (_) {
        return [];
    }
}

function fifoAssignmentRowHtml(row) {
    const aisles = (row.aisles || []).join(', ');
    return `<div class="fifo-assign-row" style="display:grid;grid-template-columns:1fr 1.4fr auto;gap:6px;align-items:center;margin-bottom:6px;background:rgba(255,255,255,0.04);padding:6px;border-radius:4px;border-left:2px solid #0f8;">
        <input class="st-input fifo-staff" list="fifo-staff-options" oninput="markFifoAssignmentsDirty()" placeholder="Staff name" value="${esc(row.staff || '')}" style="margin:0;font-size:0.85em;padding:4px 6px;" />
        <input class="st-input fifo-aisles" oninput="markFifoAssignmentsDirty()" placeholder="Aisles (comma-separated)" value="${esc(aisles)}" style="margin:0;font-size:0.85em;padding:4px 6px;" />
        <button type="button" class="st-btn" style="width:auto;padding:2px 8px;font-size:0.75em;border-color:#f33;color:#f33;" onclick="removeFifoAssignmentRow(this)">DEL</button>
    </div>`;
}

function renderFifoAssignmentsEditor(d) {
    const editor = $el('fifo-assignments-editor');
    if (!editor || dirtyFields.has('fifo-assignments')) return;
    const staffNames = (d.staff || []).filter((s) => s.active).map((s) => s.name);
    const dl = $el('fifo-staff-options');
    if (dl) dl.innerHTML = staffNames.map((n) => `<option value="${esc(n)}"></option>`).join('');
    const rows = parseFifoAssignments(d.settings);
    editor.innerHTML = rows.length
        ? rows.map((r) => fifoAssignmentRowHtml(r)).join('')
        : '<div style="color:#666;font-size:0.85em;padding:6px 0;">No assignments yet — add rows below.</div>';
}

function collectFifoAssignmentsFromEditor() {
    const rows = [];
    document.querySelectorAll('#fifo-assignments-editor .fifo-assign-row').forEach((row) => {
        const staff = (row.querySelector('.fifo-staff')?.value || '').trim();
        const aislesRaw = row.querySelector('.fifo-aisles')?.value || '';
        const aisles = aislesRaw.split(/[,·|/]+/).map((s) => s.trim()).filter(Boolean);
        if (staff && aisles.length) rows.push({ staff, aisles });
    });
    return rows;
}

window.markFifoAssignmentsDirty = () => markDirty('fifo-assignments');

window.addFifoAssignmentRow = () => {
    const editor = $el('fifo-assignments-editor');
    if (!editor) return;
    markDirty('fifo-assignments');
    const placeholder = editor.querySelector('div:not(.fifo-assign-row)');
    if (placeholder) placeholder.remove();
    editor.insertAdjacentHTML('beforeend', fifoAssignmentRowHtml({ staff: '', aisles: [] }));
};

window.removeFifoAssignmentRow = (btn) => {
    markDirty('fifo-assignments');
    btn?.closest('.fifo-assign-row')?.remove();
    const editor = $el('fifo-assignments-editor');
    if (editor && !editor.querySelector('.fifo-assign-row')) {
        editor.innerHTML = '<div style="color:#666;font-size:0.85em;padding:6px 0;">No assignments yet — add rows below.</div>';
    }
};

function updateHeatMap(d) {
    if (!d?.settings) return;
    renderFifoAisleAssignments(d.settings);
    const ZC = window.TgpZoneColors;
    let zones  = resolveZoneMapping(d.settings);
    let owners = {};
    let sectionLabels = {};
    try { owners = JSON.parse(d.settings.Zone_Ownership || '{}'); } catch (_) {}
    try { sectionLabels = JSON.parse(d.settings.Zone_Section_Labels || '{}'); } catch (_) {}

    const threshold  = 4 * 60 * 60 * 1000; // 4 hours
    const now        = Date.now();
    const mappedIds  = new Set();

    const legend = $el('map-legend');
    if (legend && Object.keys(owners).length) {
        legend.innerHTML = Object.entries(owners).map(([z, name]) => {
            const key = normalizeMapZoneKey(z);
            const color = ZC ? ZC.colorForZone(key) : '#a855f7';
            return `<span><span style="color:${color}">■</span> ${key === 'Zone 4' ? 'Z4' : esc(key)}: ${esc(name)}</span>`;
        }).join('');
    }

    const PRIORITY_MAP_CLASSES = ['map-priority-urgent', 'map-priority-high', 'map-priority-active'];

    Object.entries(zones).forEach(([zoneName, ids]) => {
        const mapKey = normalizeMapZoneKey(zoneName);
        const lastAudit = d.zoneHeatMap[zoneName];
        const isCold = isHeatMapZoneCold(lastAudit, now, threshold);
        ids.forEach(id => {
            mappedIds.add(id);
            if (id === 'map-a5') return;
            const el = $el(id);
            if (!el) return;
            const color = ZC ? ZC.colorForSection(id, mapKey) : '#a855f7';
            const fill  = ZC ? ZC.fillForSection(id, mapKey, isCold) : 'rgba(168,85,247,0.12)';
            el.style.borderColor = color;
            el.style.background  = fill;
            el.style.opacity     = isCold ? '0.88' : '1';
            el.style.boxShadow   = isCold ? 'inset 0 0 0 1px rgba(255,255,255,0.12)' : 'none';
            el.classList.remove(...PRIORITY_MAP_CLASSES);
            const priCls = ZC?.mapSectionPriorityClass
                ? ZC.mapSectionPriorityClass(id.replace(/^map-/, ''), d.tasks || [])
                : '';
            if (priCls) {
                el.classList.add(priCls);
                el.style.boxShadow = '';
            }
            const label = el.querySelector('strong');
            if (label) label.style.color = color;
        });
    });

    (ZC?.MAP_SECTION_IDS || []).forEach((id) => {
        if (mappedIds.has(id) || id === 'map-a5') return;
        const el = $el(id);
        if (!el) return;
        const color = ZC.UNMAPPED;
        const fill = ZC.fillForZone(null, true);
        el.style.borderColor = color;
        el.style.background = fill;
        el.style.opacity = '0.88';
        el.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,0.12)';
        el.classList.remove(...PRIORITY_MAP_CLASSES);
        const priCls = ZC?.mapSectionPriorityClass
            ? ZC.mapSectionPriorityClass(id.replace(/^map-/, ''), d.tasks || [])
            : '';
        if (priCls) {
            el.classList.add(priCls);
            el.style.boxShadow = '';
        }
        const label = el.querySelector('strong');
        if (label) label.style.color = color;
    });

    const a5 = sectionLabels['map-a5'];
    const a5El = $el('map-a5');
    if (a5El) {
        const a5Zone = Object.entries(zones).find(([, ids]) => ids.includes('map-a5'));
        const lastAudit = a5Zone ? d.zoneHeatMap[a5Zone[0]] : null;
        const isCold = isHeatMapZoneCold(lastAudit, now, threshold);
        const a5Pri = ZC?.mapSectionPriorityClass
            ? ZC.mapSectionPriorityClass('A5', d.tasks || [])
            : '';
        const a5Pulse = a5Pri === 'map-priority-urgent' ? 'urgent'
            : a5Pri === 'map-priority-high' ? 'high'
                : a5Pri === 'map-priority-active' ? 'active'
                    : '';
        a5El.classList.remove(...PRIORITY_MAP_CLASSES, 'map-a5-active', 'map-a5-high', 'map-a5-urgent');
        applyA5PremiumMapStyle(a5El, a5, isCold, a5Pulse);
    }

    const cmdOwner = owners['Zone 4'] || owners['COMMAND'] || owners['Command'] || '';
    const zone4Name = (() => {
        try {
            const zn = JSON.parse(d.settings.Zone_Names || '{}');
            return zn['Zone 4'] || zn.COMMAND || 'ZONE 4';
        } catch (_) { return 'ZONE 4'; }
    })();
    const cmdEl = $el('map-cmd');
    if (cmdEl) {
        cmdEl.innerHTML = `<strong style="color:#f44;">${esc(zone4Name)}: TOBACCO / WRAP AROUND${cmdOwner ? ` (${esc(cmdOwner)})` : ''}</strong>`;
    }
}

window.updateMapPreview = () => {
    const ZC = window.TgpZoneColors;
    const unmapped = ZC?.ZONE_TILE?.unmapped || { bg: 'rgba(168,85,247,0.14)', border: '#a855f7', text: '#a855f7' };
    ['map-a1','map-a2','map-a3','map-a4','map-a5','map-a6','map-a7','map-a8','map-rfz','map-fsfrz'].forEach(id => {
        const el  = $el(id);
        const sel = $el(`zsec-${id}`);
        if (!el || !sel) return;
        if (id === 'map-a5') {
            let a5Cfg = { label: 'A5', sections: [
                { label: 'Coffee', owner: 'Ashley' },
                { label: 'Monin/Torani', owner: 'Luke' },
                { label: 'Wraps', owner: 'Chandler' },
            ] };
            try {
                if (fullData?.settings?.Zone_Section_Labels) {
                    a5Cfg = JSON.parse(fullData.settings.Zone_Section_Labels)['map-a5'] || a5Cfg;
                }
            } catch (_) { /* ignore */ }
            applyA5PremiumMapStyle(el, a5Cfg, false);
            return;
        }
        const c = ZC ? ZC.tileForSection(id, sel.value) : unmapped;
        el.style.background  = c.bg;
        el.style.borderColor = c.border;
        const lbl = el.querySelector('strong');
        if (lbl) lbl.style.color = c.text;
    });
    const legend = $el('map-legend');
    if (!legend) return;
    const owners = {
        'Zone 1':  $el('zown-zone1')?.value  || 'Z1',
        'Zone 2':  $el('zown-zone2')?.value  || 'Z2',
        'Zone 3':  $el('zown-zone3')?.value  || 'Z3',
        'Zone 4':  $el('zown-command')?.value || 'Z4',
    };
    legend.innerHTML = Object.entries(owners).map(([z, name]) => {
        const color = ZC ? ZC.colorForZone(z) : '#a855f7';
        return `<span><span style="color:${color}">■</span> ${z === 'Zone 4' ? 'Z4' : esc(z)}: ${esc(name) || '—'}</span>`;
    }).join('');
};
