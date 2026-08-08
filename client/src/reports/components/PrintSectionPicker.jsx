import { useCallback, useEffect, useMemo, useState } from 'react';
import { PRINT_PRESETS, PRINT_SECTIONS } from '../constants/printSections.js';

function loadPrintSectionSelection() {
    try {
        const raw = sessionStorage.getItem('tgp_print_sections');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch (_) {
        return null;
    }
}

function savePrintSectionSelection(ids) {
    sessionStorage.setItem('tgp_print_sections', JSON.stringify(ids));
}

function visibleSectionIds() {
    return PRINT_SECTIONS
        .map((s) => s.id)
        .filter((id) => document.getElementById(id));
}

function resolvePrintSectionSelection(fallbackPreset) {
    const saved = loadPrintSectionSelection();
    if (saved && saved.length) return saved.filter((id) => document.getElementById(id));
    const preset = PRINT_PRESETS[fallbackPreset] || PRINT_PRESETS.handoff;
    return preset.filter((id) => document.getElementById(id));
}

function applyPrintSectionVisibility(selectedIds) {
    const selected = new Set(selectedIds || []);
    PRINT_SECTIONS.forEach((s) => {
        const el = document.getElementById(s.id);
        if (!el) return;
        el.classList.toggle('print-section-hidden', !selected.has(s.id));
    });
}

function clearPrintSectionVisibility() {
    PRINT_SECTIONS.forEach((s) => {
        const el = document.getElementById(s.id);
        if (el) el.classList.remove('print-section-hidden');
    });
}

function runPrintWithSections(selectedIds) {
    const ids = (selectedIds || []).filter((id) => document.getElementById(id));
    if (!ids.length) {
        alert('Select at least one report section to print.');
        return;
    }
    savePrintSectionSelection(ids);
    applyPrintSectionVisibility(ids);
    window.print();
    clearPrintSectionVisibility();
}

export function printHandoffPreset() {
    runPrintWithSections(resolvePrintSectionSelection('handoff'));
}

export default function PrintSectionPicker({ open, onClose }) {
    const available = useMemo(() => PRINT_SECTIONS.filter((s) => {
        if (typeof document === 'undefined') return true;
        return document.getElementById(s.id);
    }), [open]);

    const [selected, setSelected] = useState(() => new Set(resolvePrintSectionSelection('handoff')));

    useEffect(() => {
        if (open) {
            setSelected(new Set(resolvePrintSectionSelection('handoff')));
        }
    }, [open]);

    const groups = [...new Set(available.map((s) => s.group))];

    const toggle = useCallback((id) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const applyPreset = useCallback((name) => {
        if (name === 'none') {
            setSelected(new Set());
            return;
        }
        const preset = PRINT_PRESETS[name] || PRINT_PRESETS.handoff;
        setSelected(new Set(preset.filter((id) => document.getElementById(id))));
    }, []);

    const confirm = useCallback(() => {
        onClose();
        runPrintWithSections([...selected]);
    }, [onClose, selected]);

    if (!open) return null;

    return (
        <div
            id="print-picker-backdrop"
            className="open"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div id="print-picker" role="dialog" aria-labelledby="print-picker-title">
                <h2 id="print-picker-title">PRINT REPORTS</h2>
                <p className="picker-sub">
                    Choose which sections to include, then print. Your selection is remembered for next time.
                </p>
                <div className="print-preset-row">
                    <button type="button" className="btn ok" onClick={() => applyPreset('handoff')}>EOD HANDOFF</button>
                    <button type="button" className="btn" onClick={() => applyPreset('cold_chain')}>COLD CHAIN ONLY</button>
                    <button type="button" className="btn" onClick={() => applyPreset('all')}>ALL SECTIONS</button>
                    <button type="button" className="btn" onClick={() => applyPreset('none')}>CLEAR</button>
                </div>
                <div id="print-section-groups">
                    {groups.map((group) => (
                        <div key={group} className="print-section-group">
                            <div className="print-section-group-title">{group}</div>
                            <div className="print-section-list">
                                {available.filter((s) => s.group === group).map((s) => (
                                    <label key={s.id}>
                                        <input
                                            type="checkbox"
                                            className="print-section-cb"
                                            value={s.id}
                                            checked={selected.has(s.id)}
                                            onChange={() => toggle(s.id)}
                                        />
                                        {s.label}
                                    </label>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
                <div className="print-picker-actions">
                    <button type="button" className="btn" onClick={onClose}>CANCEL</button>
                    <button type="button" className="btn warn" onClick={confirm}>PRINT SELECTED</button>
                </div>
            </div>
        </div>
    );
}

export { visibleSectionIds, runPrintWithSections };
