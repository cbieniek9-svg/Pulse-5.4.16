import { useState } from 'react';
import { formatTime } from '../countUtils.js';

function money(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n.toFixed(2);
}

export default function DetailLineCard({ line, readOnly = false, onSave, onDelete, allowUnitUom = true }) {
    const [upc, setUpc] = useState(line.upc || '');
    const [quantity, setQuantity] = useState(String(line.quantity ?? 1));
    const [uom, setUom] = useState(line.uom || (allowUnitUom ? '' : 'case'));
    const [saving, setSaving] = useState(false);

    const cost = money(line.unit_cost);
    const retail = money(line.unit_retail);
    const qtyN = Number(line.quantity) || 0;
    const extCost = cost != null ? money(Number(cost) * qtyN) : null;
    const extRetail = retail != null ? money(Number(retail) * qtyN) : null;

    const handleSave = async () => {
        if (readOnly) return;
        if (allowUnitUom && uom !== 'case' && uom !== 'unit') {
            window.alert('Select case or unit.');
            return;
        }
        setSaving(true);
        try {
            await onSave(line.id, { upc, quantity, uom: allowUnitUom ? uom : 'case' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="card">
            <div className="scan-upc">
                {line.upc}{' '}
                <span className="scan-qty">×{line.quantity} {line.uom || ''}</span>
            </div>
            {line.item_description ? (
                <div className="card-meta">{line.item_description}</div>
            ) : null}
            <div className="card-meta">
                {formatTime(line.updated_at || line.scanned_at)}
                {cost != null || retail != null
                    ? ` · cost ${cost ?? '—'} · retail ${retail ?? '—'}`
                    : ''}
                {extCost != null || extRetail != null
                    ? ` · ext ${extCost ?? '—'} / ${extRetail ?? '—'}`
                    : ''}
            </div>
            {!readOnly ? (
                <>
                    <div className="line-edit">
                        <input
                            className="input line-upc"
                            value={upc}
                            onChange={(e) => setUpc(e.target.value)}
                        />
                        <input
                            className="input line-qty"
                            type="number"
                            min="1"
                            value={quantity}
                            onChange={(e) => setQuantity(e.target.value)}
                        />
                        {allowUnitUom ? (
                            <select
                                className="input"
                                value={uom}
                                onChange={(e) => setUom(e.target.value)}
                                style={{ minWidth: 90 }}
                            >
                                <option value="">UOM…</option>
                                <option value="case">case</option>
                                <option value="unit">unit</option>
                            </select>
                        ) : (
                            <span className="hint" style={{ alignSelf: 'center' }}>case</span>
                        )}
                        <button
                            type="button"
                            className="btn btn-sm btn-warn"
                            disabled={saving}
                            onClick={handleSave}
                        >
                            SAVE
                        </button>
                    </div>
                    <div className="row-actions">
                        <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => onDelete(line.id)}
                        >
                            DELETE
                        </button>
                    </div>
                </>
            ) : (
                <div className="hint">Session locked — reopen to edit lines.</div>
            )}
        </div>
    );
}
