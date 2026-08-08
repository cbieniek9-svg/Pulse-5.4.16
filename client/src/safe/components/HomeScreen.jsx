import { useCallback, useEffect, useState } from 'react';
import {
    createInspection,
    createInvestigation,
    fetchInspectionPrint,
    listInspections,
    listInvestigations,
    downloadInvestigationPdf,
} from '../safeApi.js';

export default function HomeScreen({
    token,
    user,
    homeTab,
    onTabChange,
    onOpenInspection,
    onOpenInvestigation,
}) {
    const [runs, setRuns] = useState([]);
    const [investigations, setInvestigations] = useState([]);
    const [runsError, setRunsError] = useState('');
    const [invError, setInvError] = useState('');
    const [busy, setBusy] = useState('');

    const refreshRuns = useCallback(async () => {
        if (!token) return;
        setRunsError('');
        try {
            const data = await listInspections(token, { limit: 24 });
            setRuns(data.runs || []);
        } catch (e) {
            setRunsError(e.message || 'Could not load inspections.');
        }
    }, [token]);

    const refreshInvestigations = useCallback(async () => {
        if (!token) return;
        setInvError('');
        try {
            const data = await listInvestigations(token, { limit: 24 });
            setInvestigations(data.investigations || []);
        } catch (e) {
            setInvError(e.message || 'Could not load investigations.');
        }
    }, [token]);

    useEffect(() => { refreshRuns(); }, [refreshRuns]);
    useEffect(() => {
        if (homeTab === 'investigations') refreshInvestigations();
    }, [homeTab, refreshInvestigations]);

    const startInspection = async () => {
        if (!window.confirm('Start a new monthly safety inspection draft?')) return;
        setBusy('inspect-start');
        try {
            const data = await createInspection(token, {});
            onOpenInspection(data);
        } catch (e) {
            alert(e.message);
        } finally {
            setBusy('');
        }
    };

    const startInvestigation = async () => {
        if (!window.confirm('Start a new incident investigation draft?')) return;
        setBusy('inv-start');
        try {
            const data = await createInvestigation(token, {});
            onOpenInvestigation(data.investigation);
        } catch (e) {
            alert(e.message);
        } finally {
            setBusy('');
        }
    };

    const printRun = async (runId) => {
        const printWindow = window.open('', '_blank');
        if (printWindow) {
            printWindow.document.write('<!doctype html><title>Safety Inspection</title><body style="font-family:Arial,sans-serif;margin:24px">Loading…</body>');
            printWindow.document.close();
        }
        try {
            await fetchInspectionPrint(token, runId, printWindow);
        } catch (e) {
            alert(e.message);
        }
    };

    const downloadInvPdf = async (id) => {
        try {
            await downloadInvestigationPdf(token, id);
        } catch (e) {
            alert(e.message);
        }
    };

    return (
        <div className="container">
            <div className="header">
                <div>
                    <div className="title">WORKSITE SAFETY</div>
                    <div className="hint">Monthly committee inspection · findings logged only (no auto tasks)</div>
                </div>
                <div style={{ fontSize: '0.8em', color: '#9c0' }}>{user}</div>
            </div>

            <div className="tab-bar">
                <button
                    type="button"
                    className={`tab ${homeTab === 'inspections' ? 'active' : ''}`}
                    onClick={() => onTabChange('inspections')}
                >
                    INSPECTIONS
                </button>
                <button
                    type="button"
                    className={`tab ${homeTab === 'investigations' ? 'active' : ''}`}
                    onClick={() => onTabChange('investigations')}
                >
                    INVESTIGATIONS
                </button>
            </div>

            {homeTab === 'inspections' ? (
                <section>
                    <div className="card-actions" style={{ marginBottom: 16 }}>
                        <button type="button" className="btn btn-submit" disabled={busy === 'inspect-start'} onClick={startInspection}>
                            START MONTHLY INSPECTION
                        </button>
                    </div>
                    <div className="section-label">RECENT INSPECTIONS</div>
                    {runsError ? (
                        <div style={{ color: '#f66', textTransform: 'none' }}>{runsError}</div>
                    ) : runs.length ? runs.map((r) => {
                        const draft = r.status === 'draft';
                        return (
                            <div className={`card ${draft ? 'draft' : 'done'}`} key={r.run_id}>
                                <div style={{ color: '#fff', fontWeight: 'bold' }}>
                                    {r.inspection_date} · {draft ? 'DRAFT' : 'SUBMITTED'}
                                </div>
                                <div className="card-meta">
                                    {draft ? `Updated ${r.updated_by || ''}` : `By ${r.submitted_by || ''}`}
                                    {r.no_count ? (
                                        <span className="badge badge-bad" style={{ marginLeft: 8 }}>{r.no_count} finding(s)</span>
                                    ) : null}
                                </div>
                                <div className="card-actions">
                                    <button type="button" className="btn btn-secondary" onClick={() => onOpenInspection(r.run_id)}>
                                        {draft ? 'CONTINUE' : 'VIEW'}
                                    </button>
                                    {!draft ? (
                                        <button type="button" className="btn" onClick={() => printRun(r.run_id)}>PRINT</button>
                                    ) : null}
                                </div>
                            </div>
                        );
                    }) : (
                        <div className="hint" style={{ textAlign: 'center', padding: 24 }}>
                            No inspections yet — start the monthly walk-through above.
                        </div>
                    )}
                </section>
            ) : (
                <section>
                    <div className="card-actions" style={{ marginBottom: 16 }}>
                        <button type="button" className="btn btn-submit" disabled={busy === 'inv-start'} onClick={startInvestigation}>
                            START INVESTIGATION
                        </button>
                    </div>
                    <div className="section-label">RECENT INVESTIGATIONS</div>
                    {invError ? (
                        <div style={{ color: '#f66', textTransform: 'none' }}>{invError}</div>
                    ) : investigations.length ? investigations.map((row) => {
                        const draft = row.status === 'draft';
                        return (
                            <div className={`card ${draft ? 'draft' : 'done'}`} key={row.id}>
                                <div style={{ color: '#fff', fontWeight: 'bold' }}>
                                    {row.incident_number} · {draft ? 'DRAFT' : 'SUBMITTED'}
                                </div>
                                <div className="card-meta">
                                    {row.person_involved || 'No person recorded'} · {row.incident_date || 'Undated'}
                                </div>
                                <div className="card-actions">
                                    <button type="button" className="btn btn-secondary" onClick={() => onOpenInvestigation(row.id)}>
                                        {draft ? 'CONTINUE' : 'VIEW'}
                                    </button>
                                    <button type="button" className="btn" onClick={() => downloadInvPdf(row.id)}>DOWNLOAD PDF</button>
                                </div>
                            </div>
                        );
                    }) : (
                        <div className="hint" style={{ textAlign: 'center', padding: 24 }}>
                            No investigations yet — start one above.
                        </div>
                    )}
                </section>
            )}
        </div>
    );
}
