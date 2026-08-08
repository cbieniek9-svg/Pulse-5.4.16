export function mins(v) {
    const n = parseFloat(v ?? 0);
    const h = Math.floor(n / 60);
    const m = Math.round(n % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function fmtIso(s) {
    if (!s) return '—';
    try {
        return new Date(s).toLocaleString();
    } catch (_) {
        return String(s);
    }
}

export function fmtDate(s) {
    return s ? String(s).slice(0, 10) : '—';
}

export function isoToDatetimeLocal(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function orderDurationMin(startIso, endIso) {
    if (!startIso || !endIso) return '—';
    try {
        const a = new Date(startIso).getTime();
        const b = new Date(endIso).getTime();
        if (!(a > 0) || !(b > 0) || b < a) return '—';
        const totalMins = Math.round((b - a) / 60000);
        if (totalMins >= 1440) return `${Math.floor(totalMins / 1440)}d ${Math.floor((totalMins % 1440) / 60)}h`;
        if (totalMins >= 60) return `${Math.floor(totalMins / 60)}h ${totalMins % 60}m`;
        return `${totalMins}m`;
    } catch (_) {
        return '—';
    }
}

export function Score({ value }) {
    const n = parseInt(value ?? 0, 10);
    const cls = n >= 80 ? 'high' : n >= 60 ? 'mid' : 'low';
    return <span className={`score ${cls}`}>{n}%</span>;
}

export function Na({ value }) {
    if (value == null || value === '') {
        return <span style={{ color: '#444' }}>—</span>;
    }
    return value;
}

export function fmtDeltaPct(card) {
    const n = Number(card?.delta_pct || 0);
    if (!Number.isFinite(n) || n === 0) return '0%';
    return `${n > 0 ? '+' : ''}${n}%`;
}
