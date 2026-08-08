const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function addDays(dateStr, delta) {
    const dt = new Date(`${dateStr}T12:00:00`);
    dt.setDate(dt.getDate() + Number(delta || 0));
    return dt.toISOString().slice(0, 10);
}

export function shiftDate(dateStr, delta) {
    return addDays(dateStr, delta);
}

export function weekNumberForDate(periodStart, storeDate) {
    if (!periodStart || !storeDate) return 1;
    const start = new Date(`${periodStart}T12:00:00`);
    const date = new Date(`${storeDate}T12:00:00`);
    const diffDays = Math.round((date - start) / 86400000);
    return Math.min(5, Math.max(1, Math.floor(diffDays / 7) + 1));
}

export function weekDates(periodStart, weekNum) {
    if (!periodStart) return [];
    const start = new Date(`${periodStart}T12:00:00`);
    start.setDate(start.getDate() + (weekNum - 1) * 7);
    return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        return d.toISOString().slice(0, 10);
    });
}

export function clampToPeriod(storeDate, periodStart, periodEnd) {
    if (!periodStart) return storeDate;
    if (storeDate < periodStart) return periodStart;
    if (periodEnd && storeDate > periodEnd) return periodEnd;
    return storeDate;
}

export function dayLabel(dateStr) {
    const dt = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(dt.getTime())) return dateStr;
    return `${DAY_NAMES[dt.getDay()]} ${dt.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`;
}

export { DAY_NAMES };
