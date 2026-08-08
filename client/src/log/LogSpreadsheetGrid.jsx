import { useMemo, useRef, useState } from 'react';
import {
    DEPT_FIELDS,
    calcDepartmentTotals,
    calcDraftTotal,
    fmtMoney,
    lineFreightTotal,
    parseAmount,
    rowHasData,
} from './logUtils.js';
import {
    GRID_FIELD_ORDER,
    focusNextGridField,
    isGridPaste,
    parseClipboardGrid,
} from './logGridNavigation.js';

function GridInput({
    rowIdx,
    fieldKey,
    className,
    value,
    inputMode,
    placeholder,
    listId,
    readOnly,
    onChange,
    onBlur,
    onKeyDown,
}) {
    return (
        <input
            className={className}
            data-grid-row={rowIdx}
            data-grid-field={fieldKey}
            inputMode={inputMode}
            value={value}
            placeholder={placeholder}
            list={listId}
            readOnly={readOnly}
            disabled={readOnly}
            onChange={onChange}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
        />
    );
}

function MoneyCell({ rowIdx, fieldKey, value, readOnly, onChange, onBlur, onKeyDown }) {
    return (
        <td className="sheet-cell sheet-num">
            <GridInput
                rowIdx={rowIdx}
                fieldKey={fieldKey}
                className="sheet-input sheet-input-num"
                inputMode="decimal"
                readOnly={readOnly}
                value={value === 0 || value === '0' ? '' : (value ?? '')}
                onChange={(ev) => onChange(ev.target.value)}
                onBlur={onBlur}
                onKeyDown={onKeyDown}
            />
        </td>
    );
}

function FreightBreakdownModal({
    row,
    readOnly,
    saving = false,
    dirty = false,
    onChange,
    onSave,
    onClose,
}) {
    if (!row) return null;
    const entered = lineFreightTotal(row);
    const payable = calcDraftTotal(row);
    const base = payable - parseAmount(row.gst);
    // Invoice-level allocated_freight is a proportional display share of the
    // day/department N3 × period dept % allocation — never purchases × rate.
    const allocated = row.allocated_freight != null && row.allocated_freight !== ''
        ? parseAmount(row.allocated_freight)
        : null;
    const landed = row.landed_purchase_cost != null && row.landed_purchase_cost !== ''
        ? parseAmount(row.landed_purchase_cost)
        : (allocated != null ? base + allocated : base);
    return (
        <div className="log-modal-backdrop" role="dialog" aria-modal="true">
            <div className="log-modal freight-breakdown-modal">
                <div className="log-modal-head">
                    <strong>Freight breakdown</strong>
                    <div className="freight-modal-actions">
                        {!readOnly ? (
                            <button
                                type="button"
                                className="log-btn"
                                disabled={saving || !dirty}
                                onClick={onSave}
                            >
                                {saving ? 'Saving…' : 'Save'}
                            </button>
                        ) : null}
                        <button type="button" className="log-btn log-btn-secondary" disabled={saving} onClick={onClose}>
                            Close
                        </button>
                    </div>
                </div>
                <p className="hint">
                    Invoice {row.invoice_number || '—'} · {row.supplier_name || '—'}
                </p>
                <table className="freight-breakdown-table">
                    <thead>
                        <tr>
                            <th>Department</th>
                            <th>Base</th>
                            <th>Invoice est. (ref)</th>
                        </tr>
                    </thead>
                    <tbody>
                        {DEPT_FIELDS.filter((f) => f.key !== 'gst' && f.key !== 'produce_shrink').map((field) => {
                            const freightKey = `freight_${field.key}`;
                            const baseAmt = parseAmount(row[field.key]);
                            return (
                                <tr key={field.key}>
                                    <td>{field.label}</td>
                                    <td>{fmtMoney(baseAmt, true)}</td>
                                    <td>
                                        <input
                                            className="sheet-input sheet-input-num"
                                            inputMode="decimal"
                                            readOnly={readOnly}
                                            disabled={readOnly || saving}
                                            value={row[freightKey] === 0 || row[freightKey] === '0' ? '' : (row[freightKey] ?? '')}
                                            onChange={(ev) => onChange({ [freightKey]: ev.target.value })}
                                        />
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                <div className="freight-breakdown-totals">
                    <div><span>Base payable</span><strong>{fmtMoney(payable)}</strong></div>
                    <div><span>Invoice Estimated Freight — Reference Only</span><strong>{fmtMoney(entered)}</strong></div>
                    {allocated != null ? (
                        <div><span>Department Allocated Freight (display share)</span><strong>{fmtMoney(allocated)}</strong></div>
                    ) : null}
                    <div><span>Landed Purchase Cost</span><strong>{fmtMoney(landed)}</strong></div>
                </div>
                <p className="hint">
                    Produce Shrink receives freight allocation under the period department allocation profile.
                    Invoice estimated freight is reference only — landed cost uses Daily Freight Allocation Total × department %.
                </p>
            </div>
        </div>
    );
}

export default function LogSpreadsheetGrid({
    storeDate,
    sheetName,
    receiverName,
    freightTotal,
    freightReconciliation = null,
    rows,
    gridMeta = null,
    busy,
    readOnly = false,
    isManager = true,
    vendorNames = [],
    rowWarnings = {},
    onReceiverChange,
    onFreightChange,
    onRowChange,
    onRowBlur,
    onDeleteRow,
    onPasteRows,
    onAddWriteOff,
    onPageChange,
    onFreightOverride,
    onFreightSave,
    onFreightClose,
    onFreightDirtyChange,
}) {
    const gridRef = useRef(null);
    const [freightRowIdx, setFreightRowIdx] = useState(null);
    const [freightModalDirty, setFreightModalDirty] = useState(false);
    const [freightSaving, setFreightSaving] = useState(false);
    const deptTotals = useMemo(() => calcDepartmentTotals(rows), [rows]);
    const recon = freightReconciliation || {};
    const expected = recon.expected ?? freightTotal;
    const entered = recon.entered ?? rows.reduce((sum, row) => sum + lineFreightTotal(row), 0);
    const diff = recon.difference != null
        ? recon.difference
        : (Number(entered) || 0) - (Number(expected) || 0);
    const status = recon.status || (Math.abs(diff) <= 0.05 ? 'PASS' : 'WARNING');

    const markFreightDirty = (dirty) => {
        setFreightModalDirty(dirty);
        onFreightDirtyChange?.(dirty);
    };

    const openFreightModal = (idx) => {
        setFreightRowIdx(idx);
        markFreightDirty(false);
    };

    const handleFreightSave = async () => {
        if (freightRowIdx == null || readOnly) return;
        setFreightSaving(true);
        try {
            const ok = await onFreightSave?.(freightRowIdx);
            if (ok) {
                markFreightDirty(false);
                setFreightRowIdx(null);
            }
        } finally {
            setFreightSaving(false);
        }
    };

    const handleFreightClose = async () => {
        if (freightRowIdx == null) return;
        if (freightModalDirty && !readOnly) {
            const shouldClose = await onFreightClose?.(freightRowIdx, { dirty: true });
            if (!shouldClose) return;
        }
        markFreightDirty(false);
        setFreightRowIdx(null);
    };

    const handleCellKeyDown = (ev, rowIdx, fieldKey) => {
        if (ev.key === 'Tab') {
            ev.preventDefault();
            focusNextGridField(gridRef.current, rowIdx, fieldKey, ev.shiftKey);
            return;
        }
        if (ev.key === 'Enter') {
            ev.preventDefault();
            focusNextGridField(gridRef.current, rowIdx, fieldKey, false);
        }
    };

    const handlePaste = (ev) => {
        if (readOnly) return;
        const target = ev.target;
        if (!target?.dataset?.gridRow) return;
        const rowIdx = Number(target.dataset.gridRow);
        const fieldKey = target.dataset.gridField;
        const startCol = GRID_FIELD_ORDER.indexOf(fieldKey);
        if (!Number.isFinite(rowIdx) || startCol < 0) return;

        const text = ev.clipboardData?.getData('text/plain');
        if (!text || !isGridPaste(text)) return;

        ev.preventDefault();
        const grid = parseClipboardGrid(text);
        const rowPatches = grid.map((cells) => {
            const patch = {};
            cells.forEach((cell, offset) => {
                const key = GRID_FIELD_ORDER[startCol + offset];
                if (key) patch[key] = cell;
            });
            return patch;
        });

        onPasteRows?.(rowIdx, rowPatches);
    };

    const page = gridMeta?.page || 0;
    const totalPages = gridMeta?.totalPages || 1;
    const showOverride = isManager && !readOnly && (status === 'FAIL' || status === 'WARNING');

    return (
        <div className={`sheet-shell${readOnly ? ' sheet-readonly-mode' : ''}`}>
            <div className="sheet-tab-row">
                <div className="sheet-tab">{sheetName || 'Daily Sheet'}</div>
                {!readOnly ? (
                    <button type="button" className="log-btn log-btn-secondary sheet-writeoff-btn" onClick={onAddWriteOff}>
                        + Write-off row
                    </button>
                ) : null}
            </div>

            <div className={`freight-recon-strip status-${String(status).toLowerCase()}`} data-testid="freight-recon">
                <div><span>Daily Freight Allocation Total</span><strong>{fmtMoney(expected)}</strong></div>
                <div><span>Invoice Estimated Freight — Reference Only</span><strong>{fmtMoney(entered)}</strong></div>
                <div><span>Difference (ref vs N3)</span><strong>{fmtMoney(diff)}</strong></div>
                <div><span>Status</span><strong>{status}</strong></div>
                {showOverride ? (
                    <button
                        type="button"
                        className="log-btn log-btn-secondary"
                        onClick={() => {
                            const reason = window.prompt('Manager reason for freight override:');
                            if (reason) onFreightOverride?.(reason);
                        }}
                    >
                        Override
                    </button>
                ) : null}
            </div>

            {gridMeta?.hasOverflow ? (
                <div className="sheet-overflow-banner" data-testid="line-overflow">
                    This day has {gridMeta.totalLines} lines (page {page + 1} of {totalPages}).
                    Totals include every line — nothing is hidden from Pulse math.
                    <span className="sheet-page-controls">
                        <button type="button" className="log-btn log-btn-secondary" disabled={page <= 0} onClick={() => onPageChange?.(page - 1)}>Prev</button>
                        <button type="button" className="log-btn log-btn-secondary" disabled={page >= totalPages - 1} onClick={() => onPageChange?.(page + 1)}>Next</button>
                    </span>
                </div>
            ) : null}

            {vendorNames.length ? (
                <datalist id="log-vendor-list">
                    {vendorNames.map((name) => (
                        <option key={name} value={name} />
                    ))}
                </datalist>
            ) : null}
            <div className="sheet-scroll" ref={gridRef}>
                <table className="sheet-grid" onPaste={handlePaste}>
                    <tbody>
                        <tr className="sheet-row-receiver">
                            <td className="sheet-corner" />
                            <td className="sheet-cell">
                                <input
                                    className="sheet-input"
                                    value={receiverName}
                                    readOnly={readOnly}
                                    disabled={readOnly}
                                    onChange={(ev) => onReceiverChange(ev.target.value)}
                                    placeholder="Receiver"
                                />
                            </td>
                            <td className="sheet-cell sheet-num sheet-freight-total" colSpan={2}>
                                <label className="hint">Daily Freight Allocation Total (N3)</label>
                                <input
                                    className="sheet-input sheet-input-num sheet-freight-input"
                                    inputMode="decimal"
                                    readOnly={readOnly}
                                    disabled={readOnly}
                                    value={freightTotal === '' || freightTotal == null ? '' : freightTotal}
                                    onChange={(ev) => onFreightChange(ev.target.value)}
                                    placeholder="0.00"
                                />
                            </td>
                            <td className="sheet-cell" colSpan={DEPT_FIELDS.length - 1} />
                            <td className="sheet-notes-head" />
                        </tr>

                        <tr className="sheet-row-date">
                            <td className="sheet-label sheet-date-label">Receiving Date:</td>
                            <td className="sheet-cell sheet-date-value" colSpan={DEPT_FIELDS.length + 2}>
                                {storeDate || '—'}
                            </td>
                            <td className="sheet-notes-head" />
                        </tr>

                        <tr className="sheet-row-headers">
                            <td className="sheet-head sticky-col">Invoice Number</td>
                            <td className="sheet-head sticky-col-2">Supplier Name</td>
                            {DEPT_FIELDS.map((field) => (
                                <td key={field.key} className="sheet-head sheet-head-num">{field.label} Purchases</td>
                            ))}
                            <td className="sheet-head sheet-head-num">Total Invoice**</td>
                            <td className="sheet-head sheet-notes-head">Notes / Freight</td>
                        </tr>

                        {rows.map((row, idx) => {
                            const rowNum = ((gridMeta?.page || 0) * (gridMeta?.pageSize || 50)) + idx + 6;
                            const total = calcDraftTotal(row);
                            const hasData = rowHasData(row);
                            const blurRow = () => { if (!readOnly) onRowBlur?.(idx); };
                            const keyNav = (ev, fieldKey) => handleCellKeyDown(ev, idx, fieldKey);
                            const warnings = rowWarnings[row.line_id] || rowWarnings[idx] || [];
                            const freightAmt = lineFreightTotal(row);

                            return (
                                <tr
                                    key={row.line_id || `row-${idx}`}
                                    className={`sheet-row-data${hasData ? ' has-data' : ''}${warnings.length ? ' has-warning' : ''}${row.line_kind === 'write-off-row' ? '' : ''}${row.line_kind === 'write_off' ? ' write-off-row' : ''}${freightAmt ? ' has-freight' : ''}`}
                                >
                                    <td className="sheet-cell sticky-col">
                                        <span className="sheet-row-index">{rowNum}</span>
                                        <GridInput
                                            rowIdx={idx}
                                            fieldKey="invoice_number"
                                            className="sheet-input"
                                            readOnly={readOnly}
                                            value={row.invoice_number || ''}
                                            onChange={(ev) => onRowChange(idx, { invoice_number: ev.target.value })}
                                            onBlur={blurRow}
                                            onKeyDown={(ev) => keyNav(ev, 'invoice_number')}
                                        />
                                    </td>
                                    <td className="sheet-cell sticky-col-2">
                                        <GridInput
                                            rowIdx={idx}
                                            fieldKey="supplier_name"
                                            className="sheet-input"
                                            listId="log-vendor-list"
                                            readOnly={readOnly}
                                            value={row.supplier_name || ''}
                                            onChange={(ev) => onRowChange(idx, { supplier_name: ev.target.value })}
                                            onBlur={blurRow}
                                            onKeyDown={(ev) => keyNav(ev, 'supplier_name')}
                                        />
                                    </td>
                                    {DEPT_FIELDS.map((field) => (
                                        <MoneyCell
                                            key={field.key}
                                            rowIdx={idx}
                                            fieldKey={field.key}
                                            value={row[field.key]}
                                            readOnly={readOnly}
                                            onChange={(value) => onRowChange(idx, { [field.key]: value })}
                                            onBlur={blurRow}
                                            onKeyDown={(ev) => keyNav(ev, field.key)}
                                        />
                                    ))}
                                    <td className="sheet-cell sheet-num sheet-readonly">{fmtMoney(total, true)}</td>
                                    <td className="sheet-cell sheet-notes">
                                        <div className="sheet-notes-row">
                                            <GridInput
                                                rowIdx={idx}
                                                fieldKey="notes"
                                                className="sheet-input"
                                                readOnly={readOnly}
                                                value={row.notes || ''}
                                                onChange={(ev) => onRowChange(idx, { notes: ev.target.value })}
                                                onBlur={blurRow}
                                                onKeyDown={(ev) => keyNav(ev, 'notes')}
                                            />
                                            {hasData ? (
                                                <button
                                                    type="button"
                                                    className={`log-btn log-btn-secondary freight-btn${freightAmt ? ' active' : ''}`}
                                                    title="Freight breakdown"
                                                    onClick={() => openFreightModal(idx)}
                                                >
                                                    {freightAmt ? `F ${fmtMoney(freightAmt)}` : 'Freight'}
                                                </button>
                                            ) : null}
                                            {!readOnly && row.line_id ? (
                                                <button
                                                    type="button"
                                                    className="log-btn log-btn-secondary"
                                                    onClick={() => onDeleteRow?.(row.line_id, row)}
                                                >
                                                    ×
                                                </button>
                                            ) : null}
                                        </div>
                                        {warnings.length ? (
                                            <div className="sheet-row-warnings">{warnings.map((w) => w.message || w).join(' · ')}</div>
                                        ) : null}
                                    </td>
                                </tr>
                            );
                        })}

                        <tr className="sheet-row-dept-total">
                            <td className="sheet-label sticky-col" colSpan={2}>Department Totals</td>
                            {DEPT_FIELDS.map((field) => (
                                <td key={field.key} className="sheet-cell sheet-num sheet-readonly sheet-total-strong">
                                    {fmtMoney(deptTotals[field.key], true)}
                                </td>
                            ))}
                            <td className="sheet-cell sheet-num sheet-readonly sheet-total-strong">
                                {fmtMoney(deptTotals.invoice_total, true)}
                            </td>
                            <td className="sheet-notes-head" />
                        </tr>
                    </tbody>
                </table>
            </div>
            {busy ? <div className="sheet-busy">{busy}</div> : null}
            {freightRowIdx != null ? (
                <FreightBreakdownModal
                    row={rows[freightRowIdx]}
                    readOnly={readOnly}
                    saving={freightSaving || !!busy}
                    dirty={freightModalDirty}
                    onClose={handleFreightClose}
                    onSave={handleFreightSave}
                    onChange={(patch) => {
                        onRowChange(freightRowIdx, patch);
                        markFreightDirty(true);
                    }}
                />
            ) : null}
        </div>
    );
}
