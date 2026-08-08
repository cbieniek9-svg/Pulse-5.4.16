import { useState } from 'react';
import { useReportsContext } from '../context/ReportsContext.jsx';

export default function ExecStrip({ data }) {
    const { viewStart, viewEnd, applyViewDate, setReportMode } = useReportsContext();
    const [startDraft, setStartDraft] = useState('');
    const [endDraft, setEndDraft] = useState('');

    const m = data.meta || {};
    const rd = m.reportDate || data.today;
    const rs = m.reportStart || rd;
    const re = m.reportEnd || rd;
    const live = m.liveStoreDate || rd;
    const kpi = data.report_kpi_strip || {};
    const odb = data.order_day_briefing || {};
    const fah = data.finish_archive_health || {};

    const startVal = viewStart || rs;
    const endVal = viewEnd || re;

    const handleApply = () => {
        applyViewDate(startDraft || startVal, endDraft || endVal);
    };

    return (
        <div className="exec-strip" id="sec-exec">
            <span className={`chip ${m.reportSource === 'backup' ? 'warn' : ''}`}>
                {m.reportSource === 'backup' ? 'BACKUP' : 'LIVE'}
            </span>
            {rs === re ? (
                <span className="chip">REPORT: {rs}</span>
            ) : (
                <span className="chip">RANGE: {rs} → {re}</span>
            )}
            {m.reportSource !== 'backup' ? <span className="chip">STORE: {live}</span> : null}
            {m.isLiveToday === false ? <span className="chip warn">HISTORICAL</span> : null}
            {kpi.actions_urgent ? (
                <span className="chip warn">{kpi.actions_urgent} URGENT</span>
            ) : (
                <span className="chip ok">CLEAR</span>
            )}
            {kpi.tasks_open != null ? (
                <span className={`chip ${kpi.tasks_open > 5 ? 'warn' : ''}`}>{kpi.tasks_open} OPEN TASKS</span>
            ) : null}
            {odb.is_order_day && kpi.order_adj_pph != null ? (
                <span className="chip">ORDER {Number(kpi.order_adj_pph).toFixed(1)} ADJ PPH</span>
            ) : null}
            {fah.complete_order_days != null && !fah.phase0_ready ? (
                <button
                    type="button"
                    className="chip warn"
                    style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit' }}
                    onClick={() => setReportMode('learn')}
                    title="Full detail in LEARN"
                >
                    ARCHIVE NEEDS WORK
                </button>
            ) : fah.phase0_ready ? (
                <span className="chip ok">SCORECARD OK</span>
            ) : null}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <label htmlFor="report-view-start">START</label>
                <input
                    type="date"
                    id="report-view-start"
                    value={startDraft || startVal}
                    onChange={(e) => setStartDraft(e.target.value)}
                />
                <label htmlFor="report-view-end">END</label>
                <input
                    type="date"
                    id="report-view-end"
                    value={endDraft || endVal}
                    onChange={(e) => setEndDraft(e.target.value)}
                />
                <button type="button" className="btn ok" style={{ padding: '6px 14px' }} onClick={handleApply}>
                    APPLY RANGE
                </button>
            </div>
        </div>
    );
}
