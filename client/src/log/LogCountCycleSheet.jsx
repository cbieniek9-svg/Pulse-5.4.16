import { useEffect, useMemo, useState } from 'react';
import { saveCountCycle } from './logApi.js';
import { formatMoney, formatPct, formatShortDate, isInvalidAmount, parseSheetAmount } from './logAnalyticsUtils.js';

const DEPT_ORDER = ['total_grocery', 'centre_store', 'dairy', 'meat', 'produce', 'tobacco'];

function MoneyInput({ value, disabled, onSave }) {
    const [draft, setDraft] = useState(null);
    const display = draft != null ? draft : (value != null ? String(value) : '');

    return (
        <input
            className="count-cycle-input"
            inputMode="decimal"
            disabled={disabled}
            value={display}
            onChange={(ev) => setDraft(ev.target.value)}
            onFocus={() => setDraft(value != null ? String(value) : '')}
            onBlur={() => {
                const nextRaw = draft;
                setDraft(null);
                if (nextRaw === null) return;
                if (isInvalidAmount(nextRaw)) {
                    alert('Not a number — cell not saved');
                    return;
                }
                const next = nextRaw === '' ? null : parseSheetAmount(nextRaw);
                const prev = value == null ? null : Number(value);
                if (next === prev || (next == null && prev == null)) return;
                if (next != null && prev != null && Number(next) === Number(prev)) return;
                onSave(next);
            }}
        />
    );
}

export default function LogCountCycleSheet({
    token,
    periodStart,
    countCycle,
    busy,
    readOnly = false,
    onRefresh,
}) {
    const [saving, setSaving] = useState(false);
    const [notes, setNotes] = useState('');

    useEffect(() => {
        setNotes(countCycle?.notes || '');
    }, [countCycle?.notes, countCycle?.count_period_start]);

    const deptRows = useMemo(
        () => DEPT_ORDER.map((key) => countCycle?.departments?.[key]).filter(Boolean),
        [countCycle],
    );

    if (!countCycle) {
        return <div className="log-panel-empty">Loading count cycle…</div>;
    }

    const periodNums = countCycle.period_numbers || [];
    const missing = countCycle.missing_periods || [];
    const tg = countCycle.departments?.total_grocery;

    const save = async (patch) => {
        if (readOnly) return;
        setSaving(true);
        try {
            await saveCountCycle(token, {
                cycle_end_period_start: periodStart,
                ...patch,
            });
            await onRefresh();
        } catch (e) {
            alert(e.message);
        } finally {
            setSaving(false);
        }
    };

    const toggleCountPeriod = async (checked) => {
        await save({ is_count_period: checked ? 1 : 0 });
    };

    const saveClosing = async (dept, amount) => {
        await save({
            is_count_period: 1,
            counted_closing: { [dept]: amount },
        });
    };

    const saveOpening = async (dept, amount) => {
        await save({
            is_count_period: 1,
            cycle_opening: { [dept]: amount },
        });
    };

    return (
        <div className="sheet-shell sheet-shell-wide count-cycle-shell">
            <div className="sheet-banner">
                <div>
                    <div className="sheet-banner-title">Count Cycle</div>
                    <div className="sheet-banner-sub">
                        Physical count rollup · Periods{' '}
                        {periodNums.filter(Boolean).join('–') || '—'}
                        {countCycle.count_period_start
                            ? ` · count period starts ${formatShortDate(countCycle.count_period_start)}`
                            : ''}
                        {countCycle.active_period_start
                            && countCycle.active_period_start !== countCycle.count_period_start
                            ? ` · viewing from ${formatShortDate(countCycle.active_period_start)}`
                            : ''}
                    </div>
                </div>
                <div className="sheet-banner-stats">
                    <div>
                        <strong>{formatPct(tg?.gross_margin_pct)}</strong>
                        <span> cycle GP%</span>
                    </div>
                    {countCycle.vs_prior_cycle_gp_pct != null ? (
                        <div>
                            <strong>
                                {countCycle.vs_prior_cycle_gp_pct > 0 ? '+' : ''}
                                {formatPct(countCycle.vs_prior_cycle_gp_pct)}
                            </strong>
                            <span> vs prior cycle</span>
                        </div>
                    ) : null}
                </div>
            </div>

            <div className="count-cycle-toolbar">
                <label className="count-cycle-toggle">
                    <input
                        type="checkbox"
                        checked={!!countCycle.is_count_period}
                        disabled={readOnly || !!busy || saving}
                        onChange={(ev) => toggleCountPeriod(ev.target.checked)}
                    />
                    <span>This is a count period</span>
                </label>
                {!countCycle.cycle_complete ? (
                    <div className="count-cycle-warn">
                        Missing period data
                        {missing.length ? `: ${missing.join(', ')}` : ''}.
                        Import prior workbooks (e.g. P7 + P8) and snapshot each before relying on cycle GP%.
                    </div>
                ) : (
                    <div className="count-cycle-ok">Three-period inputs loaded.</div>
                )}
            </div>

            <div className="sheet-scroll">
                <table className="sheet-grid count-cycle-grid">
                    <thead>
                        <tr>
                            <th>Department</th>
                            {(countCycle.periods || []).map((period, idx) => (
                                <th key={`s-${idx}`}>
                                    Sales P{period.period_number ?? '?'}
                                    {period.period_start ? (
                                        <div className="count-cycle-th-sub">
                                            {formatShortDate(period.period_start)}
                                            {period.period_end ? ` → ${formatShortDate(period.period_end)}` : ''}
                                        </div>
                                    ) : null}
                                </th>
                            ))}
                            <th>Sales total</th>
                            {(countCycle.periods || []).map((period, idx) => (
                                <th key={`p-${idx}`}>
                                    Purch P{period.period_number ?? '?'}
                                    {period.period_start ? (
                                        <div className="count-cycle-th-sub">{formatShortDate(period.period_start)}</div>
                                    ) : null}
                                </th>
                            ))}
                            <th>Purch total</th>
                            <th>Cycle open</th>
                            <th>Counted close</th>
                            <th>COGS</th>
                            <th>GP$</th>
                            <th>GP%</th>
                        </tr>
                    </thead>
                    <tbody>
                        {deptRows.map((dept) => (
                            <tr key={dept.key} className={dept.key === 'total_grocery' ? 'sheet-row-highlight' : ''}>
                                <td className="sheet-label sticky-col">{dept.label}</td>
                                {(dept.sales_by_period || []).map((row, idx) => (
                                    <td key={`ss-${idx}`} className={`sheet-num${row.missing ? ' count-cycle-missing' : ''}`}>
                                        {formatMoney(row.amount)}
                                    </td>
                                ))}
                                <td className="sheet-num sheet-total-strong">{formatMoney(dept.sales_total)}</td>
                                {(dept.purchases_by_period || []).map((row, idx) => (
                                    <td key={`pp-${idx}`} className={`sheet-num${row.missing ? ' count-cycle-missing' : ''}`}>
                                        {formatMoney(row.amount)}
                                    </td>
                                ))}
                                <td className="sheet-num sheet-total-strong">{formatMoney(dept.purchases_total)}</td>
                                <td className="sheet-num">
                                    {readOnly ? formatMoney(dept.opening) : (
                                        <MoneyInput
                                            value={dept.opening}
                                            disabled={!!busy || saving}
                                            onSave={(v) => saveOpening(dept.key, v)}
                                        />
                                    )}
                                </td>
                                <td className="sheet-num">
                                    {readOnly ? formatMoney(dept.closing) : (
                                        <MoneyInput
                                            value={dept.closing}
                                            disabled={!!busy || saving}
                                            onSave={(v) => saveClosing(dept.key, v)}
                                        />
                                    )}
                                </td>
                                <td className="sheet-num">{formatMoney(dept.cogs)}</td>
                                <td className="sheet-num">{formatMoney(dept.gross_profit)}</td>
                                <td className="sheet-num sheet-total-strong">{formatPct(dept.gross_margin_pct)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <label className="count-cycle-notes">
                <span>Notes</span>
                <textarea
                    value={notes}
                    disabled={readOnly || !!busy || saving}
                    onChange={(ev) => setNotes(ev.target.value)}
                    onBlur={() => {
                        if (readOnly) return;
                        if ((notes || '') === (countCycle.notes || '')) return;
                        save({ notes });
                    }}
                    rows={3}
                    placeholder="Physical count notes, adjustments, timing…"
                />
            </label>
        </div>
    );
}
