import { useCallback, useState } from 'react';
import { confirmRemainingSalesZero, saveSalesNumber } from './logApi.js';
import { formatMoney, formatShortDate, isInvalidAmount, parseSheetAmount } from './logAnalyticsUtils.js';

function EditableCell({
    value,
    integer,
    disabled,
    onCommit,
}) {
    const [draft, setDraft] = useState(null);

    const display = draft != null
        ? draft
        : (value === '' || value == null ? '' : (integer ? String(value) : formatMoney(value)));

    return (
        <input
            className="sheet-input sheet-input-num"
            value={display}
            disabled={disabled}
            onChange={(ev) => setDraft(ev.target.value)}
            onFocus={() => setDraft(value === '' || value == null ? '' : (integer ? String(value) : String(value)))}
            onBlur={() => {
                if (draft == null) return;
                if (isInvalidAmount(draft)) {
                    alert('Not a number — cell not saved');
                    setDraft(null);
                    return;
                }
                const trimmed = String(draft).trim();
                const originalBlank = value === '' || value == null;
                const original = originalBlank
                    ? null
                    : (integer ? Math.round(Number(value)) : Number(value));
                if (trimmed === '' && originalBlank) {
                    setDraft(null);
                    return;
                }
                const next = parseSheetAmount(draft);
                const committed = integer ? Math.round(next) : next;
                setDraft(null);
                if (!originalBlank && Number(original) === Number(committed)) return;
                onCommit(committed);
            }}
            onKeyDown={(ev) => {
                if (ev.key === 'Enter') ev.currentTarget.blur();
            }}
        />
    );
}

export default function LogSalesSheet({
    token,
    periodStart,
    sales,
    busy,
    readOnly = false,
    onRefresh,
}) {
    const [savingKey, setSavingKey] = useState('');
    const [confirmingWeek, setConfirmingWeek] = useState(0);

    const saveCell = useCallback(async (categoryKey, weekNum, amount) => {
        if (readOnly) return;
        const key = `${categoryKey}:${weekNum}`;
        setSavingKey(key);
        try {
            await saveSalesNumber(token, {
                period_start: periodStart,
                category_key: categoryKey,
                week_num: weekNum,
                amount,
            });
            await onRefresh();
        } catch (e) {
            alert(e.message);
        } finally {
            setSavingKey('');
        }
    }, [token, periodStart, onRefresh, readOnly]);

    const confirmWeekZero = useCallback(async (weekNum) => {
        const reason = window.prompt('Reason for confirming all remaining blank sales cells as zero:');
        if (!reason?.trim()) return;
        setConfirmingWeek(weekNum);
        try {
            await confirmRemainingSalesZero(token, {
                period_start: periodStart,
                category_key: '__week__',
                week_num: weekNum,
                reason: reason.trim(),
            });
            await onRefresh();
        } catch (e) {
            alert(e.message);
        } finally {
            setConfirmingWeek(0);
        }
    }, [token, periodStart, onRefresh]);

    if (!sales) {
        return <div className="log-panel-empty">Loading sales numbers…</div>;
    }

    const weekEnds = sales.week_ends || [];

    return (
        <div className="sheet-shell sheet-shell-wide">
            <div className="sheet-banner">
                <div>
                    <div className="sheet-banner-title">Sales Numbers</div>
                    <div className="sheet-banner-sub">
                        Period {sales.period_number || '—'} · starts {formatShortDate(sales.period_start)}
                    </div>
                </div>
            </div>

            <div className="sheet-scroll">
                <table className="sheet-grid sales-grid">
                    <thead>
                        <tr className="sheet-row-head">
                            <th className="sticky-col sticky-col-a">Code</th>
                            <th className="sticky-col sticky-col-b">Department</th>
                            {weekEnds.map((weekEnding, idx) => (
                                <th key={weekEnding} className="sheet-head sheet-head-week">
                                    <div>Wk {idx + 1}</div>
                                    <div className="sheet-head-mini">{formatShortDate(weekEnding)}</div>
                                    {!readOnly ? (
                                        <button
                                            type="button"
                                            className="log-btn log-btn-secondary log-btn-small"
                                            disabled={!!confirmingWeek}
                                            onClick={() => confirmWeekZero(idx + 1)}
                                        >
                                            {confirmingWeek === idx + 1 ? 'Confirming…' : 'Confirm blanks zero'}
                                        </button>
                                    ) : null}
                                </th>
                            ))}
                            <th className="sheet-head sheet-head-total">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sales.categories.map((cat) => (
                            <tr key={cat.key} className="sheet-row-data">
                                <td className="sticky-col sticky-col-a sheet-code">{cat.code || ''}</td>
                                <td className="sticky-col sticky-col-b sheet-label">{cat.label}</td>
                                {[1, 2, 3, 4, 5].map((weekNum) => (
                                    <td key={weekNum} className="sheet-cell sheet-cell-num">
                                        <EditableCell
                                            value={cat.entered_weeks?.includes(weekNum)
                                                ? cat.weeks?.[weekNum]
                                                : ''}
                                            integer={cat.integer}
                                            disabled={readOnly || busy || savingKey === `${cat.key}:${weekNum}`}
                                            onCommit={(amount) => saveCell(cat.key, weekNum, amount)}
                                        />
                                    </td>
                                ))}
                                <td className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                    {cat.integer ? cat.total : formatMoney(cat.total)}
                                </td>
                            </tr>
                        ))}

                        <tr className="sheet-row-spacer"><td colSpan={8} /></tr>

                        <tr className="sheet-row-summary">
                            <td className="sticky-col sticky-col-a" />
                            <td className="sticky-col sticky-col-b sheet-label">Tobacco</td>
                            {[1, 2, 3, 4, 5].map((w) => (
                                <td key={w} className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                    {formatMoney(sales.summary?.tobacco?.[w])}
                                </td>
                            ))}
                            <td className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                {formatMoney(sales.summary?.tobacco?.total)}
                            </td>
                        </tr>
                        <tr className="sheet-row-summary">
                            <td className="sticky-col sticky-col-a" />
                            <td className="sticky-col sticky-col-b sheet-label">Meat</td>
                            {[1, 2, 3, 4, 5].map((w) => (
                                <td key={w} className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                    {formatMoney(sales.summary?.meat?.[w])}
                                </td>
                            ))}
                            <td className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                {formatMoney(sales.summary?.meat?.total)}
                            </td>
                        </tr>
                        <tr className="sheet-row-summary">
                            <td className="sticky-col sticky-col-a" />
                            <td className="sticky-col sticky-col-b sheet-label">Fruits and Veg</td>
                            {[1, 2, 3, 4, 5].map((w) => (
                                <td key={w} className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                    {formatMoney(sales.summary?.fruits_veg?.[w])}
                                </td>
                            ))}
                            <td className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                {formatMoney(sales.summary?.fruits_veg?.total)}
                            </td>
                        </tr>
                        <tr className="sheet-row-summary sheet-row-highlight">
                            <td className="sticky-col sticky-col-a" />
                            <td className="sticky-col sticky-col-b sheet-label">Grocery</td>
                            {[1, 2, 3, 4, 5].map((w) => (
                                <td key={w} className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                    {formatMoney(sales.summary?.grocery?.[w])}
                                </td>
                            ))}
                            <td className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                {formatMoney(sales.summary?.grocery?.total)}
                            </td>
                        </tr>
                        <tr className="sheet-row-summary">
                            <td className="sticky-col sticky-col-a" />
                            <td className="sticky-col sticky-col-b sheet-label">Total</td>
                            {[1, 2, 3, 4, 5].map((w) => (
                                <td key={w} className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                    {formatMoney(sales.summary?.total?.[w])}
                                </td>
                            ))}
                            <td className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                {formatMoney(sales.summary?.total?.total)}
                            </td>
                        </tr>
                        <tr className="sheet-row-summary">
                            <td className="sticky-col sticky-col-a" />
                            <td className="sticky-col sticky-col-b sheet-label">Produce dept</td>
                            {[1, 2, 3, 4, 5].map((w) => (
                                <td key={w} className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                    {formatMoney(sales.summary?.produce_dept?.[w])}
                                </td>
                            ))}
                            <td className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                {formatMoney(sales.summary?.produce_dept?.total)}
                            </td>
                        </tr>
                        <tr className="sheet-row-summary">
                            <td className="sticky-col sticky-col-a" />
                            <td className="sticky-col sticky-col-b sheet-label">Centre store</td>
                            {[1, 2, 3, 4, 5].map((w) => (
                                <td key={w} className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                    {formatMoney(sales.summary?.centre_store?.[w])}
                                </td>
                            ))}
                            <td className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                {formatMoney(sales.summary?.centre_store?.total)}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div className="sheet-side-panel">
                <div className="sheet-side-title">Weekly rollups</div>
                <table className="sheet-mini-grid">
                    <thead>
                        <tr>
                            <th>Group</th>
                            {[1, 2, 3, 4, 5].map((w) => <th key={w}>Wk {w}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {(sales.rollups || []).map((group) => (
                            <tr key={group.key}>
                                <td>{group.label}</td>
                                {[1, 2, 3, 4, 5].map((w) => (
                                    <td key={w}>{formatMoney(group.weeks?.[w])}</td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
