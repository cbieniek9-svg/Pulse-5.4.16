import { useState } from 'react';
import { formatMoney, formatPct, isInvalidAmount, parseSheetAmount } from './logAnalyticsUtils.js';

function focusDraft(value, pct) {
    return pct ? String((Number(value || 0) * 100)) : String(value ?? '');
}

/** Editable margin input — skips save when draft is null or unchanged. */
export function MarginField({ label, value, pct, onSave, disabled }) {
    const [draft, setDraft] = useState(null);
    const display = draft != null
        ? draft
        : (pct ? (value != null ? `${(Number(value) * 100).toFixed(4)}` : '') : formatMoney(value));

    return (
        <label className="margin-field">
            <span>{label}</span>
            <input
                value={display}
                disabled={disabled}
                onChange={(ev) => setDraft(ev.target.value)}
                onFocus={() => setDraft(focusDraft(value, pct))}
                onBlur={() => {
                    if (draft == null) return;
                    if (isInvalidAmount(draft)) {
                        alert(`Not a number: ${label} — not saved`);
                        setDraft(null);
                        return;
                    }
                    const raw = parseSheetAmount(draft);
                    const next = pct ? raw / 100 : raw;
                    const baseline = focusDraft(value, pct);
                    setDraft(null);
                    if (String(draft).trim() === String(baseline).trim()) return;
                    onSave(next);
                }}
            />
        </label>
    );
}

export function ReadRow({ label, value, pct, strong }) {
    return (
        <div className={`margin-read-row${strong ? ' strong' : ''}`}>
            <span>{label}</span>
            <span>{pct ? formatPct(value) : formatMoney(value)}</span>
        </div>
    );
}
