export function fmtTime(iso) {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
        return '—';
    }
}

/** Calendar day arithmetic on YYYY-MM-DD stamps (noon local avoids DST edge cases). */
export function addDays(dateStr, delta) {
    const d = new Date(`${String(dateStr).slice(0, 10)}T12:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    d.setDate(d.getDate() + Number(delta || 0));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function isoToDatetimeLocal(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function datetimeLocalToIso(s) {
    if (!s) return '';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
}

export function isTgpVendor(vendor) {
    return /^TGP\b/i.test(String(vendor || '').trim());
}

export function formatLicensePlatesInput(value) {
    const raw = String(value || '').toUpperCase().replace(/\s+/g, '');
    if (!raw) return '';
    return raw.replace(/([0-9])(?=[A-Z])/g, '$1 ').replace(/\s+/g, ' ').trim();
}

export function deptLabel(list, id) {
    const row = (list || []).find((d) => d.id === id);
    return row?.label || id || '—';
}

export function deptStorage(list, deptId) {
    const d = (list || []).find((x) => x.id === deptId);
    return d?.storage || 'refrigerated';
}

export function deptRequiresTemp(list, deptId) {
    const d = (list || []).find((x) => x.id === deptId);
    return d?.requires_temp !== false;
}

export function isTempInRange(list, deptId, temp) {
    const t = Number(temp);
    if (!Number.isFinite(t)) return false;
    const storage = deptStorage(list, deptId);
    if (storage === 'ambient') return t > 0;
    if (storage === 'frozen') return t <= -18;
    return t >= 1 && t <= 4;
}

export function formatSpotLine(p) {
    const s1 = p.temp_spot_1;
    const s2 = p.temp_spot_2;
    const s3 = p.temp_spot_3;
    if (s1 != null && s2 != null && s3 != null) {
        return `${s1} / ${s2} / ${s3} → avg ${p.temp_c}`;
    }
    if (p.temp_c != null && Number.isFinite(Number(p.temp_c))) return `${p.temp_c}°C`;
    return 'No temp';
}

export function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
    }, 500);
}

export const XFER_UPCHARGE = 0.0725;

export function calcXferLineExt(qty, cost) {
    const q = Number(qty);
    const c = Number(cost);
    if (!Number.isFinite(q) || !Number.isFinite(c)) return null;
    const unit = c + c * XFER_UPCHARGE;
    return { unit, ext: q * unit, pieces: q };
}
