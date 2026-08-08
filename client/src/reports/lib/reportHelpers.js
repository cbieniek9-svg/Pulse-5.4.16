export function isOrderDayActive(d) {
    const odb = d.order_day_briefing || {};
    const ot = d.order_today || {};
    return !!odb.is_order_day || !!(ot.start && !ot.end);
}

export function actionInboxCount(d) {
    const actions = d.report_actions || [];
    if (!actions.length) return 0;
    return actions.filter((a) => a.priority === 'urgent' || a.priority === 'warn').length || actions.length;
}

export function groupByField(rows, field) {
    const groups = {};
    (rows || []).forEach((r) => {
        const key = String(r[field] || 'UNKNOWN').slice(0, 10);
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
    });
    return Object.keys(groups)
        .sort((a, b) => b.localeCompare(a))
        .map((k) => ({ key: k, rows: groups[k] }));
}

export function trendCardClass(card) {
    const key = card?.key || '';
    const n = Number(card?.delta_pct || 0);
    if (!n) return '';
    if (['oos_opened', 'outdated_item_logs', 'expiry_pull_logs', 'urgent_tasks_created'].includes(key)) {
        return n > 0 ? 'warn' : 'ok';
    }
    if (['avg_adjusted_pph', 'tasks_closed', 'oos_closed', 'daily_direction_posted_days'].includes(key)) {
        return n < 0 ? 'warn' : 'ok';
    }
    return '';
}

export function laborVerdictClass(verdict) {
    if (verdict === 'surplus') return 'ok';
    if (verdict === 'tight') return 'warn';
    if (verdict === 'under') return 'urgent';
    return '';
}

export function rosterSuggestionConfidenceLabel(confidence) {
    if (confidence === 'strong') return '3+ runs';
    if (confidence === 'solid') return '2 runs';
    return '1 run';
}

export function parseRosterText(raw) {
    return String(raw || '')
        .split(/[,;|]/)
        .map((n) => n.trim())
        .filter(Boolean);
}

export function rangeLabelFromMeta(d) {
    const meta = d.meta || {};
    const rd = meta.reportDate || d.today;
    const rs = meta.reportStart || rd;
    const re = meta.reportEnd || rd;
    return rs === re ? rd : `${rs} → ${re}`;
}

export function isMultiDay(d) {
    const meta = d.meta || {};
    const rd = meta.reportDate || d.today;
    const rs = meta.reportStart || rd;
    const re = meta.reportEnd || rd;
    return rs !== re;
}
