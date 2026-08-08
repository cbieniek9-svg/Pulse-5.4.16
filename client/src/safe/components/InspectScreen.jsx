import { useEffect, useState } from 'react';
import { getInspection, saveInspection, submitInspection, fetchInspectionPrint } from '../safeApi.js';
import { sectionIssueNoteKey } from '../safeUtils.js';

function buildFormState(activeRun, form) {
    const answers = (activeRun.sections || []).flatMap((section) => section.items.map((item) => ({
        item_id: item.item_id,
        answer: form.answers[item.item_id] ?? item.answer ?? null,
        note: form.notes[item.item_id] ?? item.note ?? '',
    })));
    const signatures = [];
    Object.entries(form.signatures || {}).forEach(([key, name]) => {
        const trimmed = String(name || '').trim();
        if (!trimmed) return;
        const [role, slot] = key.split(':');
        signatures.push({ role_type: role, slot_num: Number(slot), print_name: trimmed });
    });
    const state = {
        inspection_date: form.inspectionDate || activeRun?.run?.inspection_date,
        answers,
        signatures,
    };
    Object.entries(form.sectionNotes || {}).forEach(([sectionKey, value]) => {
        const noteKey = sectionIssueNoteKey(sectionKey);
        if (noteKey) state[noteKey] = value || '';
    });
    return state;
}

function hydrateForm(run) {
    const signatures = {};
    (run.signatures || []).forEach((s) => {
        signatures[`${s.role_type}:${s.slot_num}`] = s.print_name || '';
    });
    const answers = {};
    const notes = {};
    (run.sections || []).forEach((section) => {
        section.items.forEach((item) => {
            answers[item.item_id] = item.answer ?? null;
            notes[item.item_id] = item.note || '';
        });
    });
    const sectionNotes = {};
    (run.sections || []).forEach((section) => {
        const key = sectionIssueNoteKey(section.section_key);
        if (key) sectionNotes[section.section_key] = run.run?.[key] || '';
    });
    return {
        inspectionDate: run.run?.inspection_date || '',
        answers,
        notes,
        signatures,
        sectionNotes,
    };
}

export default function InspectScreen({ token, runIdOrPayload, onBack }) {
    const [activeRun, setActiveRun] = useState(null);
    const [loading, setLoading] = useState(true);
    const [form, setForm] = useState({ inspectionDate: '', answers: {}, notes: {}, signatures: {}, sectionNotes: {} });
    const [busy, setBusy] = useState('');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!runIdOrPayload) return;
            setLoading(true);
            try {
                const payload = typeof runIdOrPayload === 'string'
                    ? await getInspection(token, runIdOrPayload)
                    : runIdOrPayload;
                if (cancelled) return;
                setActiveRun(payload);
                setForm(hydrateForm(payload));
            } catch (e) {
                if (!cancelled) {
                    alert(e.message);
                    onBack();
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [runIdOrPayload, token, onBack]);

    const submitted = activeRun?.run?.status === 'submitted';
    const readOnly = submitted;

    const setAnswer = (itemId, value) => {
        setForm((f) => ({ ...f, answers: { ...f.answers, [itemId]: value } }));
    };

    const setNote = (itemId, value) => {
        setForm((f) => ({ ...f, notes: { ...f.notes, [itemId]: value } }));
    };

    const setSignature = (key, value) => {
        setForm((f) => ({ ...f, signatures: { ...f.signatures, [key]: value } }));
    };

    const setSectionNote = (sectionKey, value) => {
        setForm((f) => ({ ...f, sectionNotes: { ...f.sectionNotes, [sectionKey]: value } }));
    };

    const saveDraft = async () => {
        if (!activeRun?.run || activeRun.run.status !== 'draft') return;
        setBusy('save');
        try {
            const updated = await saveInspection(token, activeRun.run.run_id, buildFormState(activeRun, form));
            setActiveRun(updated);
            setForm(hydrateForm(updated));
            alert('Draft saved.');
        } catch (e) {
            alert(e.message);
        } finally {
            setBusy('');
        }
    };

    const submit = async () => {
        if (!activeRun?.run || activeRun.run.status !== 'draft') return;
        if (!window.confirm('Submit this inspection? It will be locked and available for print/filing.')) return;
        setBusy('submit');
        try {
            await saveInspection(token, activeRun.run.run_id, buildFormState(activeRun, form));
            const updated = await submitInspection(token, activeRun.run.run_id);
            setActiveRun(updated);
            setForm(hydrateForm(updated));
            alert('Inspection submitted.');
        } catch (e) {
            alert(e.message);
        } finally {
            setBusy('');
        }
    };

    const printInspection = async () => {
        const printWindow = window.open('', '_blank');
        if (printWindow) {
            printWindow.document.write('<!doctype html><title>Safety Inspection</title><body style="font-family:Arial,sans-serif;margin:24px">Loading…</body>');
            printWindow.document.close();
        }
        try {
            await fetchInspectionPrint(token, activeRun.run.run_id, printWindow);
        } catch (e) {
            alert(e.message);
        }
    };

    if (loading || !activeRun?.run) {
        return <div className="container"><div className="hint">Loading…</div></div>;
    }

    const sigVal = (role, slot) => form.signatures[`${role}:${slot}`] || '';

    return (
        <div className="container">
            <div className="header">
                <div>
                    <div className="title">{activeRun.template?.title || 'SAFETY INSPECTION'}</div>
                    <div className="hint">
                        {submitted
                            ? `Submitted by ${activeRun.run.submitted_by || ''}`
                            : `Draft · ${activeRun.stats?.answered_count || 0}/${activeRun.stats?.item_count || 0} answered`}
                    </div>
                </div>
                <button type="button" className="btn btn-secondary" onClick={onBack}>BACK</button>
            </div>

            <label className="hint" htmlFor="inspect-date">Inspection date</label>
            <input
                id="inspect-date"
                type="date"
                className="input"
                value={form.inspectionDate}
                disabled={readOnly}
                onChange={(e) => setForm((f) => ({ ...f, inspectionDate: e.target.value }))}
            />

            {(activeRun.sections || []).map((section) => (
                <div key={section.section_key || section.title}>
                    <div className="section-label">{section.title}</div>
                    {section.items.map((item) => (
                        <div className="item-row" key={item.item_id}>
                            <div className="item-no">#{item.item_no}</div>
                            <div className="item-prompt">{item.prompt}</div>
                            <div className="answer-row">
                                {['na', 'yes', 'no'].map((val) => (
                                    <label key={val}>
                                        <input
                                            type="radio"
                                            name={item.item_id}
                                            value={val}
                                            checked={form.answers[item.item_id] === val}
                                            disabled={readOnly}
                                            onChange={() => setAnswer(item.item_id, val)}
                                        />
                                        {val.toUpperCase()}
                                    </label>
                                ))}
                            </div>
                            <label className="item-note-label" htmlFor={`note-${item.item_id}`}>Item notes (optional)</label>
                            <textarea
                                id={`note-${item.item_id}`}
                                className="textarea item-note"
                                maxLength={500}
                                placeholder="Finding detail, location, or follow-up…"
                                readOnly={readOnly}
                                value={form.notes[item.item_id] || ''}
                                onChange={(e) => setNote(item.item_id, e.target.value)}
                            />
                        </div>
                    ))}
                    {sectionIssueNoteKey(section.section_key) ? (
                        <>
                            <label className="section-notes-label" htmlFor={`section-note-${section.section_key}`}>
                                {section.title} — section notes (optional)
                            </label>
                            <textarea
                                id={`section-note-${section.section_key}`}
                                className="textarea section-notes"
                                placeholder="General notes, follow-ups, or issue summary for this section…"
                                readOnly={readOnly}
                                value={form.sectionNotes[section.section_key] || ''}
                                onChange={(e) => setSectionNote(section.section_key, e.target.value)}
                            />
                        </>
                    ) : null}
                </div>
            ))}

            <div className="section-label">COMMITTEE SIGNATURES (OPTIONAL)</div>
            <div className="sig-grid">
                <div>
                    <div className="hint">Management committee</div>
                    <input className="input" placeholder="Name (print) — slot 1" readOnly={readOnly} value={sigVal('mgmt', 1)} onChange={(e) => setSignature('mgmt:1', e.target.value)} />
                    <input className="input" placeholder="Name (print) — slot 2" readOnly={readOnly} value={sigVal('mgmt', 2)} onChange={(e) => setSignature('mgmt:2', e.target.value)} />
                </div>
                <div>
                    <div className="hint">Non-management committee</div>
                    <input className="input" placeholder="Name (print) — slot 1" readOnly={readOnly} value={sigVal('non_mgmt', 1)} onChange={(e) => setSignature('non_mgmt:1', e.target.value)} />
                    <input className="input" placeholder="Name (print) — slot 2" readOnly={readOnly} value={sigVal('non_mgmt', 2)} onChange={(e) => setSignature('non_mgmt:2', e.target.value)} />
                </div>
            </div>

            <div className="card-actions" style={{ marginTop: 20 }}>
                {!submitted ? (
                    <>
                        <button type="button" className="btn btn-secondary" disabled={busy === 'save'} onClick={saveDraft}>SAVE DRAFT</button>
                        <button type="button" className="btn btn-submit" disabled={busy === 'submit'} onClick={submit}>SUBMIT INSPECTION</button>
                    </>
                ) : (
                    <button type="button" className="btn" onClick={printInspection}>PRINT FORM</button>
                )}
            </div>
        </div>
    );
}
