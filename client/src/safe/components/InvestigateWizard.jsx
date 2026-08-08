import { useEffect, useRef, useState } from 'react';
import SignaturePad from './SignaturePad.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { formatApiError, getSync } from '../../lib/api.js';
import {
    getInvestigation,
    saveInvestigation as saveInvestigationApi,
    submitInvestigation as submitInvestigationApi,
    reopenInvestigation as reopenInvestigationApi,
    uploadInvestigationAttachment,
    deleteInvestigationAttachment,
    saveInvestigationSignature,
    downloadInvestigationPdf,
} from '../safeApi.js';
import {
    prepareInvestigation,
    investigationPatch,
    clientMissingFields,
    getPath,
    setPath,
    isManagerRole,
} from '../safeUtils.js';
import {
    INCIDENT_TYPES,
    EVENT_TYPES,
    ACTS,
    CONDITIONS,
    ROOT_PERSONAL,
    ROOT_JOB,
    CORRECTIVE_AREAS,
    SUPPORTING_DOCS,
    INVESTIGATION_STEPS,
} from '../safeConstants.js';

const MANAGER_ONLY_SIGN_ROLES = new Set(['safety_committee', 'senior_management']);

function alertApiError(err, fallback) {
    alert(formatApiError(err, fallback || err?.message || 'Request failed'));
}

function FieldInput({ label, path, type = 'text', value, readOnly, onChange, extra = {} }) {
    return (
        <>
            <label className="field-label">{label}</label>
            <input
                className="input"
                type={type}
                value={value ?? ''}
                readOnly={readOnly}
                onChange={(e) => onChange(path, e.target.value)}
                {...extra}
            />
        </>
    );
}

function TextAreaField({ label, path, value, readOnly, onChange, placeholder = '' }) {
    return (
        <>
            <label className="field-label">{label}</label>
            <textarea
                className="textarea"
                value={value ?? ''}
                readOnly={readOnly}
                placeholder={placeholder}
                onChange={(e) => onChange(path, e.target.value)}
            />
        </>
    );
}

function CheckGrid({ path, options, values, readOnly, onToggle }) {
    return (
        <div className="check-grid">
            {options.map((opt) => {
                const key = opt[0];
                const label = opt[1];
                const num = opt.length > 2 ? opt[2] : null;
                return (
                    <label key={key}>
                        <input
                            type="checkbox"
                            checked={!!values?.[key]}
                            disabled={readOnly}
                            onChange={(e) => onToggle(`${path}.${key}`, e.target.checked)}
                        />
                        {num != null && num !== '' ? <span className="check-num">{num}.</span> : null}
                        {label}
                    </label>
                );
            })}
        </div>
    );
}

function RadioSet({ path, value, readOnly, onChange, options = [['yes', 'Yes'], ['no', 'No'], ['na', 'N/A']] }) {
    return (
        <div className="radio-set">
            {options.map(([key, label]) => (
                <label key={key}>
                    <input
                        type="radio"
                        name={path}
                        value={key}
                        checked={value === key}
                        disabled={readOnly}
                        onChange={() => onChange(path, key)}
                    />
                    {label}
                </label>
            ))}
        </div>
    );
}

function SignoffBlock({ role, label, investigation, readOnly, canSign, padRef, onUseSignature }) {
    const value = investigation.signoffs?.[role] || {};
    const showPad = !readOnly && canSign;
    return (
        <div className="signature-card">
            <div className="section-label" style={{ marginTop: 0 }}>{label}</div>
            <div className="form-grid two">
                <div>
                    <FieldInput label="Name" path={`signoffs.${role}.name`} value={value.name} readOnly onChange={() => {}} />
                </div>
                <div>
                    <FieldInput label="Date" path={`signoffs.${role}.date`} type="date" value={value.date} readOnly onChange={() => {}} />
                </div>
            </div>
            {value.signatureFile ? (
                <div className="hint" style={{ color: '#0f8' }}>Signature saved: {value.signatureFile}</div>
            ) : (
                <div className="hint">No signature saved.</div>
            )}
            {showPad ? (
                <>
                    <SignaturePad ref={padRef} disabled={false} />
                    <div className="card-actions">
                        <button type="button" className="btn btn-secondary" onClick={() => padRef.current?.clear()}>CLEAR</button>
                        <button type="button" className="btn" onClick={() => onUseSignature(role, padRef)}>USE SIGNATURE</button>
                    </div>
                </>
            ) : null}
            {!readOnly && !canSign ? (
                <div className="hint">Manager login required to sign this role.</div>
            ) : null}
        </div>
    );
}

export default function InvestigateWizard({ token, idOrPayload, onBack }) {
    const { user } = useAuth();
    const [investigation, setInvestigation] = useState(null);
    const [step, setStep] = useState(0);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState('');
    const [isManager, setIsManager] = useState(false);
    const leadPadRef = useRef(null);
    const committeePadRef = useRef(null);
    const mgmtPadRef = useRef(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!token || !user) {
                if (!cancelled) setIsManager(false);
                return;
            }
            try {
                const sync = await getSync(token);
                const me = (sync?.staff || []).find((s) => s.name === user);
                if (!cancelled) setIsManager(isManagerRole(me?.role));
            } catch (_) {
                if (!cancelled) setIsManager(false);
            }
        })();
        return () => { cancelled = true; };
    }, [token, user]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!idOrPayload) return;
            setLoading(true);
            try {
                const raw = typeof idOrPayload === 'string'
                    ? (await getInvestigation(token, idOrPayload)).investigation
                    : idOrPayload;
                if (cancelled) return;
                setInvestigation(prepareInvestigation(raw));
                setStep(0);
            } catch (e) {
                if (!cancelled) {
                    alertApiError(e, 'Could not load investigation.');
                    onBack('investigations');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [idOrPayload, token, onBack]);

    const readOnly = investigation?.status !== 'draft';
    const canSignRole = (role) => {
        if (readOnly) return false;
        if (MANAGER_ONLY_SIGN_ROLES.has(role)) return isManager;
        return true;
    };

    const updateField = (path, value) => {
        setInvestigation((prev) => {
            const next = structuredClone(prev);
            setPath(next, path, value);
            return next;
        });
    };

    const updateCheck = (path, checked) => {
        setInvestigation((prev) => {
            const next = structuredClone(prev);
            setPath(next, path, checked);
            return next;
        });
    };

    const updateWitness = (index, field, value) => {
        setInvestigation((prev) => {
            const next = structuredClone(prev);
            const witnesses = [...(next.witnesses || [])];
            while (witnesses.length <= index) witnesses.push({ name: '', contact: '' });
            witnesses[index] = { ...witnesses[index], [field]: value };
            next.witnesses = witnesses;
            return next;
        });
    };

    const persist = async (notify = false) => {
        if (!investigation || investigation.status !== 'draft') return investigation;
        const data = await saveInvestigationApi(token, investigation.id, investigationPatch(investigation));
        const prepared = prepareInvestigation(data.investigation);
        setInvestigation(prepared);
        if (notify) alert('Draft saved.');
        return prepared;
    };

    const saveDraft = async () => {
        setBusy('save');
        try {
            await persist(true);
        } catch (e) {
            alertApiError(e, 'Could not save draft.');
        } finally {
            setBusy('');
        }
    };

    const goNext = async () => {
        if (!investigation) return;
        if (investigation.status === 'draft') {
            setBusy('next');
            try {
                await persist(false);
            } catch (e) {
                alertApiError(e, 'Could not save draft.');
                setBusy('');
                return;
            }
            setBusy('');
        }
        if (step < 7) setStep((s) => s + 1);
    };

    const goBack = () => {
        if (step > 0) setStep((s) => s - 1);
    };

    const handleUpload = async (event) => {
        const files = event.target.files;
        if (!investigation?.id || !files?.length) return;
        setBusy('upload');
        try {
            for (const file of files) {
                await uploadInvestigationAttachment(token, investigation.id, file);
            }
            const data = await getInvestigation(token, investigation.id);
            setInvestigation(prepareInvestigation(data.investigation));
        } catch (e) {
            alertApiError(e, 'Upload failed.');
        } finally {
            setBusy('');
            event.target.value = '';
        }
    };

    const handleDeleteAttachment = async (attId) => {
        if (!investigation || !window.confirm('Delete this attachment?')) return;
        setBusy('delete');
        try {
            await deleteInvestigationAttachment(token, investigation.id, attId);
            const data = await getInvestigation(token, investigation.id);
            setInvestigation(prepareInvestigation(data.investigation));
        } catch (e) {
            alertApiError(e, 'Could not delete attachment.');
        } finally {
            setBusy('');
        }
    };

    const handleUseSignature = async (role, padRef) => {
        if (!canSignRole(role)) {
            alertApiError(
                { code: 'SIGNATURE_ROLE_FORBIDDEN', message: 'Manager login required for this signature role.' },
                'Manager login required for this signature role.',
            );
            return;
        }
        const dataUrl = padRef.current?.toDataUrl();
        if (!dataUrl) {
            alert('Draw a signature first.');
            return;
        }
        setBusy(`sig-${role}`);
        try {
            await persist(false);
            const data = await saveInvestigationSignature(token, investigation.id, role, dataUrl);
            setInvestigation(prepareInvestigation(data.investigation));
            alert('Signature saved.');
        } catch (e) {
            alertApiError(e, 'Could not save signature.');
        } finally {
            setBusy('');
        }
    };

    const handleSubmit = async () => {
        setBusy('submit');
        try {
            await persist(false);
            const data = await submitInvestigationApi(token, investigation.id);
            setInvestigation(prepareInvestigation(data.investigation));
            await downloadInvestigationPdf(token, investigation.id);
        } catch (e) {
            alertApiError(e, 'Could not submit investigation.');
        } finally {
            setBusy('');
        }
    };

    const handleReopen = async () => {
        if (!investigation || !isManager) return;
        if (!window.confirm('Reopen this investigation for amendments? Original submit metadata stays on file.')) return;
        setBusy('reopen');
        try {
            const data = await reopenInvestigationApi(token, investigation.id);
            setInvestigation(prepareInvestigation(data.investigation));
            alert('Investigation reopened as draft.');
        } catch (e) {
            alertApiError(e, 'Could not reopen investigation.');
        } finally {
            setBusy('');
        }
    };

    const handleDownloadPdf = async () => {
        setBusy('pdf');
        try {
            if (investigation?.status === 'draft') await persist(false);
            await downloadInvestigationPdf(token, investigation.id);
        } catch (e) {
            alertApiError(e, 'PDF download failed.');
        } finally {
            setBusy('');
        }
    };

    if (loading || !investigation) {
        return <div className="container"><div className="hint">Loading…</div></div>;
    }

    const missing = step === 7 ? clientMissingFields(investigation) : [];
    const attachments = investigation.attachments || [];

    let stepContent = null;
    if (step === 0) {
        stepContent = (
            <>
                <div className="wizard-step-title">Basics</div>
                <div className="hint">Record the people and timing first. Your draft is saved as you advance.</div>
                <div className="form-grid two">
                    <FieldInput label="Incident number" path="incident_number" value={investigation.incident_number} readOnly onChange={updateField} extra={{ readOnly: true }} />
                    <FieldInput label="Report date" path="report_date" type="date" value={investigation.report_date} readOnly={readOnly} onChange={updateField} />
                    <FieldInput label="Report time" path="report_time" type="time" value={investigation.report_time} readOnly={readOnly} onChange={updateField} />
                </div>
                <label className="field-label">Report AM / PM</label>
                <RadioSet path="report_ampm" value={investigation.report_ampm} readOnly={readOnly} onChange={updateField} options={[['AM', 'AM'], ['PM', 'PM']]} />
                <div className="form-grid two">
                    <FieldInput label="Retail name" path="retail_name" value={investigation.retail_name} readOnly={readOnly} onChange={updateField} />
                    <FieldInput label="Person involved" path="person_involved" value={investigation.person_involved} readOnly={readOnly} onChange={updateField} />
                </div>
                <div className="section-label">PERSON TYPE</div>
                <CheckGrid path="person_types" options={[['full_time', 'Full-time'], ['part_time', 'Part-time'], ['contractor', 'Contractor'], ['customer', 'Customer']]} values={investigation.person_types} readOnly={readOnly} onToggle={updateCheck} />
                <div className="form-grid two">
                    <FieldInput label="Incident date" path="incident_date" type="date" value={investigation.incident_date} readOnly={readOnly} onChange={updateField} />
                    <FieldInput label="Incident time" path="incident_time" type="time" value={investigation.incident_time} readOnly={readOnly} onChange={updateField} />
                </div>
                <label className="field-label">Incident AM / PM</label>
                <RadioSet path="incident_ampm" value={investigation.incident_ampm} readOnly={readOnly} onChange={updateField} options={[['AM', 'AM'], ['PM', 'PM']]} />
                <div className="section-label">WITNESSES</div>
                {[0, 1, 2].map((index) => {
                    const witness = investigation.witnesses?.[index] || {};
                    return (
                        <div className="form-grid two" key={index}>
                            <div>
                                <label className="field-label">Witness {index + 1}</label>
                                <input className="input" placeholder="Name" value={witness.name || ''} readOnly={readOnly} onChange={(e) => updateWitness(index, 'name', e.target.value)} />
                            </div>
                            <div>
                                <label className="field-label">Contact / statement reference</label>
                                <input className="input" placeholder="Optional" value={witness.contact || ''} readOnly={readOnly} onChange={(e) => updateWitness(index, 'contact', e.target.value)} />
                            </div>
                        </div>
                    );
                })}
            </>
        );
    } else if (step === 1) {
        stepContent = (
            <>
                <div className="wizard-step-title">Description</div>
                <div className="hint">Write the sequence chronologically: before, during, and after the event. Add any sketch in the documents step.</div>
                {Array.from({ length: 10 }, (_, index) => (
                    <TextAreaField
                        key={index}
                        label={`Chronological detail ${index + 1}`}
                        path={`payload.descriptionLines.${index}`}
                        value={getPath(investigation, `payload.descriptionLines.${index}`)}
                        readOnly={readOnly}
                        onChange={updateField}
                        placeholder={index === 0 ? 'Required — begin the account of the incident…' : 'Continue the sequence…'}
                    />
                ))}
            </>
        );
    } else if (step === 2) {
        stepContent = (
            <>
                <div className="wizard-step-title">Process & event type</div>
                <div className="item-row"><div className="item-prompt">Hazard assessment completed?</div><RadioSet path="payload.process.hazardAssessment" value={getPath(investigation, 'payload.process.hazardAssessment')} readOnly={readOnly} onChange={updateField} /></div>
                <div className="item-row"><div className="item-prompt">Controls implemented?</div><RadioSet path="payload.process.controlsImplemented" value={getPath(investigation, 'payload.process.controlsImplemented')} readOnly={readOnly} onChange={updateField} /></div>
                <div className="item-row"><div className="item-prompt">JHA exists?</div><RadioSet path="payload.process.jhaExists" value={getPath(investigation, 'payload.process.jhaExists')} readOnly={readOnly} onChange={updateField} /></div>
                <div className="item-row"><div className="item-prompt">JHA followed?</div><RadioSet path="payload.process.jhaFollowed" value={getPath(investigation, 'payload.process.jhaFollowed')} readOnly={readOnly} onChange={updateField} /></div>
                <TextAreaField label="Equipment / materials involved" path="payload.process.equipmentMaterials" value={getPath(investigation, 'payload.process.equipmentMaterials')} readOnly={readOnly} onChange={updateField} />
                <div className="section-label">INCIDENT TYPE</div>
                <CheckGrid path="payload.incidentTypes" options={INCIDENT_TYPES} values={investigation.payload?.incidentTypes} readOnly={readOnly} onToggle={updateCheck} />
                <FieldInput label="Other incident type" path="payload.incidentTypeOther" value={getPath(investigation, 'payload.incidentTypeOther')} readOnly={readOnly} onChange={updateField} />
                <div className="section-label">EVENT TYPE</div>
                <CheckGrid path="payload.eventTypes" options={EVENT_TYPES} values={investigation.payload?.eventTypes} readOnly={readOnly} onToggle={updateCheck} />
            </>
        );
    } else if (step === 3) {
        stepContent = (
            <>
                <div className="wizard-step-title">Causes</div>
                <p className="hint">Green numbers are the paper-form IDs. Use them in the I/D # and B/R # boxes below (acts 1–20, conditions 21–40, root 1–16).</p>
                <div className="section-label">SUBSTANDARD ACTS (I/D # 1–20)</div>
                <CheckGrid path="payload.substandardActs" options={ACTS} values={investigation.payload?.substandardActs} readOnly={readOnly} onToggle={updateCheck} />
                <FieldInput label="Other substandard act" path="payload.substandardActsOther" value={getPath(investigation, 'payload.substandardActsOther')} readOnly={readOnly} onChange={updateField} />
                <div className="section-label">SUBSTANDARD CONDITIONS (I/D # 21–40)</div>
                <CheckGrid path="payload.substandardConditions" options={CONDITIONS} values={investigation.payload?.substandardConditions} readOnly={readOnly} onToggle={updateCheck} />
                <FieldInput label="Other substandard condition" path="payload.substandardConditionsOther" value={getPath(investigation, 'payload.substandardConditionsOther')} readOnly={readOnly} onChange={updateField} />
                <div className="section-label">IMMEDIATE CONTRIBUTIONS</div>
                <p className="hint">I/D # = number of the act/condition you checked above.</p>
                {Array.from({ length: 5 }, (_, n) => (
                    <div className="repeat-row" key={n}>
                        <input className="input" placeholder="I/D #" inputMode="numeric" value={investigation.payload.immediateContributions[n]?.idNum || ''} readOnly={readOnly} onChange={(e) => updateField(`payload.immediateContributions.${n}.idNum`, e.target.value)} />
                        <input className="input" placeholder="How that cause contributed" value={investigation.payload.immediateContributions[n]?.explanation || ''} readOnly={readOnly} onChange={(e) => updateField(`payload.immediateContributions.${n}.explanation`, e.target.value)} />
                    </div>
                ))}
                <div className="section-label">ROOT CAUSES — PERSONAL (B/R # 1–8)</div>
                <CheckGrid path="payload.rootPersonal" options={ROOT_PERSONAL} values={investigation.payload?.rootPersonal} readOnly={readOnly} onToggle={updateCheck} />
                <FieldInput label="Other personal factor" path="payload.rootPersonalOther" value={getPath(investigation, 'payload.rootPersonalOther')} readOnly={readOnly} onChange={updateField} />
                <div className="section-label">ROOT CAUSES — JOB (B/R # 9–16)</div>
                <CheckGrid path="payload.rootJob" options={ROOT_JOB} values={investigation.payload?.rootJob} readOnly={readOnly} onToggle={updateCheck} />
                <FieldInput label="Other job factor" path="payload.rootJobOther" value={getPath(investigation, 'payload.rootJobOther')} readOnly={readOnly} onChange={updateField} />
                <div className="section-label">ROOT CAUSE LINKS</div>
                <p className="hint">I/D # from acts/conditions · B/R # from root causes above.</p>
                {Array.from({ length: 5 }, (_, n) => (
                    <div className="repeat-row root" key={n}>
                        <input className="input" placeholder="I/D #" inputMode="numeric" value={investigation.payload.rootLinks[n]?.idNum || ''} readOnly={readOnly} onChange={(e) => updateField(`payload.rootLinks.${n}.idNum`, e.target.value)} />
                        <input className="input" placeholder="B/R #" inputMode="numeric" value={investigation.payload.rootLinks[n]?.brNum || ''} readOnly={readOnly} onChange={(e) => updateField(`payload.rootLinks.${n}.brNum`, e.target.value)} />
                        <input className="input" placeholder="How I/D links to root cause" value={investigation.payload.rootLinks[n]?.explanation || ''} readOnly={readOnly} onChange={(e) => updateField(`payload.rootLinks.${n}.explanation`, e.target.value)} />
                    </div>
                ))}
            </>
        );
    } else if (step === 4) {
        stepContent = (
            <>
                <div className="wizard-step-title">Corrective actions</div>
                <p className="hint">Green numbers are CA #. Use them with I/D # and B/R # from the Causes step.</p>
                <div className="section-label">CORRECTIVE ACTION AREAS (CA # 1–22)</div>
                <CheckGrid path="payload.correctiveAreas" options={CORRECTIVE_AREAS} values={investigation.payload?.correctiveAreas} readOnly={readOnly} onToggle={updateCheck} />
                <FieldInput label="Other corrective area" path="payload.correctiveOther" value={getPath(investigation, 'payload.correctiveOther')} readOnly={readOnly} onChange={updateField} />
                <div className="section-label">CONTRIBUTION LINKS</div>
                <p className="hint">I/D # · B/R # · CA # — the numbers shown next to each checkbox.</p>
                {Array.from({ length: 8 }, (_, n) => (
                    <div className="repeat-row corrective" key={n}>
                        <input className="input" placeholder="I/D #" inputMode="numeric" value={investigation.payload.correctiveLinks[n]?.idNum || ''} readOnly={readOnly} onChange={(e) => updateField(`payload.correctiveLinks.${n}.idNum`, e.target.value)} />
                        <input className="input" placeholder="B/R #" inputMode="numeric" value={investigation.payload.correctiveLinks[n]?.brNum || ''} readOnly={readOnly} onChange={(e) => updateField(`payload.correctiveLinks.${n}.brNum`, e.target.value)} />
                        <input className="input" placeholder="CA #" inputMode="numeric" value={investigation.payload.correctiveLinks[n]?.caNum || ''} readOnly={readOnly} onChange={(e) => updateField(`payload.correctiveLinks.${n}.caNum`, e.target.value)} />
                        <input className="input" style={{ gridColumn: '1 / -1' }} placeholder="How causes lead to this corrective area" value={investigation.payload.correctiveLinks[n]?.explanation || ''} readOnly={readOnly} onChange={(e) => updateField(`payload.correctiveLinks.${n}.explanation`, e.target.value)} />
                    </div>
                ))}
                <div className="section-label">ACTION LOG</div>
                {Array.from({ length: 5 }, (_, n) => (
                    <div className="repeat-row action" key={n}>
                        <input className="input" placeholder="Action required" value={investigation.payload.actionLog[n]?.action || ''} readOnly={readOnly} onChange={(e) => updateField(`payload.actionLog.${n}.action`, e.target.value)} />
                        <input className="input" placeholder="Responsible person" value={investigation.payload.actionLog[n]?.person || ''} readOnly={readOnly} onChange={(e) => updateField(`payload.actionLog.${n}.person`, e.target.value)} />
                        <input className="input" type="date" value={investigation.payload.actionLog[n]?.dueDate || ''} readOnly={readOnly} onChange={(e) => updateField(`payload.actionLog.${n}.dueDate`, e.target.value)} />
                    </div>
                ))}
            </>
        );
    } else if (step === 5) {
        stepContent = (
            <>
                <div className="wizard-step-title">Docs & uploads</div>
                <div className="section-label">SUPPORTING DOCUMENTS</div>
                {SUPPORTING_DOCS.map(([key, label]) => (
                    <div className="item-row" key={key}>
                        <div className="item-prompt">{label}</div>
                        <div className="hint">Utilized</div>
                        <RadioSet path={`payload.supportingDocs.${key}.utilized`} value={getPath(investigation, `payload.supportingDocs.${key}.utilized`)} readOnly={readOnly} onChange={updateField} />
                        <div className="hint">Copy attached</div>
                        <RadioSet path={`payload.supportingDocs.${key}.copyAttached`} value={getPath(investigation, `payload.supportingDocs.${key}.copyAttached`)} readOnly={readOnly} onChange={updateField} />
                    </div>
                ))}
                {!readOnly ? (
                    <>
                        <label className="field-label">Upload files (JPEG, PNG, WebP, or PDF; 10 MB each)</label>
                        <input className="input" type="file" multiple accept=".jpg,.jpeg,.png,.webp,.pdf" disabled={busy === 'upload'} onChange={handleUpload} />
                    </>
                ) : null}
                <div className="attachments-list">
                    {attachments.length ? attachments.map((a) => (
                        <div className="attachment" key={a.id}>
                            <span>{a.original_name} <span className="hint">({a.kind})</span></span>
                            {!readOnly ? (
                                <button type="button" className="btn btn-warn" disabled={busy === 'delete'} onClick={() => handleDeleteAttachment(a.id)}>DELETE</button>
                            ) : null}
                        </div>
                    )) : <div className="hint">No uploaded attachments.</div>}
                </div>
            </>
        );
    } else if (step === 6) {
        stepContent = (
            <>
                <div className="wizard-step-title">Sign-off</div>
                <div className="hint">Draw a signature, then choose Use signature. Name and date are stamped from your login (committee and senior management require a manager).</div>
                <SignoffBlock role="lead" label="Lead investigator" investigation={investigation} readOnly={readOnly} canSign={canSignRole('lead')} padRef={leadPadRef} onUseSignature={handleUseSignature} />
                <SignoffBlock role="safety_committee" label="Safety committee" investigation={investigation} readOnly={readOnly} canSign={canSignRole('safety_committee')} padRef={committeePadRef} onUseSignature={handleUseSignature} />
                <SignoffBlock role="senior_management" label="Senior management" investigation={investigation} readOnly={readOnly} canSign={canSignRole('senior_management')} padRef={mgmtPadRef} onUseSignature={handleUseSignature} />
            </>
        );
    } else {
        stepContent = (
            <>
                <div className="wizard-step-title">Review</div>
                <div className="hint">The final submission checks the same required fields as the server.</div>
                {missing.length ? (
                    <div className="card">
                        <div className="section-label" style={{ color: '#f99', marginTop: 0 }}>MISSING REQUIRED FIELDS</div>
                        <ul className="missing-list">{missing.map((x) => <li key={x}>{x}</li>)}</ul>
                    </div>
                ) : (
                    <div className="card done">Required submission fields are complete.</div>
                )}
                <div className="card-actions">
                    {!readOnly ? (
                        <button type="button" className="btn btn-secondary" disabled={busy === 'save'} onClick={saveDraft}>SAVE DRAFT</button>
                    ) : null}
                    {!readOnly ? (
                        <button type="button" className="btn btn-submit" disabled={busy === 'submit'} onClick={handleSubmit}>SUBMIT & DOWNLOAD PDF</button>
                    ) : null}
                    {investigation.status === 'submitted' && isManager ? (
                        <button type="button" className="btn btn-warn" disabled={busy === 'reopen'} onClick={handleReopen}>REOPEN FOR AMEND</button>
                    ) : null}
                    <button type="button" className="btn" disabled={busy === 'pdf'} onClick={handleDownloadPdf}>DOWNLOAD PDF PREVIEW</button>
                </div>
            </>
        );
    }

    return (
        <div className="container">
            <div className="header">
                <div>
                    <div className="title">INCIDENT INVESTIGATION</div>
                    <div className="hint">{investigation.incident_number || 'Draft'} · {investigation.status === 'submitted' ? 'SUBMITTED' : 'DRAFT'}</div>
                    <div className="wizard-progress">Step {step + 1} of 8 — {INVESTIGATION_STEPS[step]}</div>
                </div>
                <div className="card-actions" style={{ margin: 0 }}>
                    {investigation.status === 'submitted' && isManager ? (
                        <button type="button" className="btn btn-warn" disabled={busy === 'reopen'} onClick={handleReopen}>REOPEN</button>
                    ) : null}
                    <button type="button" className="btn btn-secondary" onClick={() => onBack('investigations')}>BACK</button>
                </div>
            </div>

            <div>{stepContent}</div>

            {step !== 7 ? (
                <div className="card-actions" style={{ marginTop: 20 }}>
                    {step > 0 ? (
                        <button type="button" className="btn btn-secondary" onClick={goBack}>BACK</button>
                    ) : null}
                    {!readOnly ? (
                        <button type="button" className="btn btn-secondary" disabled={busy === 'save'} onClick={saveDraft}>SAVE DRAFT</button>
                    ) : null}
                    <button
                        type="button"
                        className="btn btn-submit"
                        disabled={busy === 'next' || busy === 'submit'}
                        onClick={step === 7 ? handleSubmit : goNext}
                    >
                        {step === 7 ? 'SUBMIT & DOWNLOAD PDF' : 'NEXT'}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
