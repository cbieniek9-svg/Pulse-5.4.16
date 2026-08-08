import { useState } from 'react';
import { useFloorUi } from '../../shared/NoticeProvider.jsx';

const AUDIT_ZONES = [
    'Zone 1|Chandler',
    'Zone 2|Ashley',
    'Zone 3|Luke',
    'Zone 4|Chris',
];

export default function HomeBaseAuditsPanel() {
    const { actions, showNotice } = useFloorUi();
    const [zone, setZone] = useState(AUDIT_ZONES[0]);
    const [front, setFront] = useState('1');
    const [tag, setTag] = useState('1');
    const [hole, setHole] = useState('1');
    const [clear, setClear] = useState('1');
    const [notes, setNotes] = useState('');
    const [exportStart, setExportStart] = useState('');
    const [exportEnd, setExportEnd] = useState('');
    const [exportPrem, setExportPrem] = useState('');

    const submit = async () => {
        const [zone_name, premium_name] = zone.split('|');
        const audit = {
            zone_name,
            premium_name: premium_name || '',
            front_edge_pass: Number(front),
            tag_integrity_pass: Number(tag),
            hole_strategy_pass: Number(hole),
            clearances_pass: Number(clear),
            notes,
        };
        try {
            await actions.submitAudit(audit);
            showNotice('Audit submitted', 'success');
            setNotes('');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const exportAudits = async () => {
        const params = new URLSearchParams();
        if (exportStart) params.set('start', exportStart);
        if (exportEnd) params.set('end', exportEnd);
        if (exportPrem) params.set('premium', exportPrem);
        try {
            await actions.exportAudits(params.toString());
            showNotice('Preparing download…', 'info');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    return (
        <>
            <label className="section-label">NEW AUDIT</label>
            <select className="st-input" value={zone} onChange={(e) => setZone(e.target.value)}>
                {AUDIT_ZONES.map((z) => {
                    const [zn, prem] = z.split('|');
                    return <option key={z} value={z}>{zn} - {prem}</option>;
                })}
            </select>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                {[['FRONT-EDGE', front, setFront], ['TAG INTEGRITY', tag, setTag], ['HOLE STRATEGY', hole, setHole], ['CLEARANCES', clear, setClear]].map(([lbl, val, setVal]) => (
                    <div key={lbl} style={{ fontSize: '0.8em', color: '#fff' }}>
                        <label style={{ fontSize: '0.7em', color: '#8cf', display: 'block' }}>{lbl}</label>
                        <label><input type="radio" checked={val === '1'} onChange={() => setVal('1')} /> P </label>
                        <label><input type="radio" checked={val === '0'} onChange={() => setVal('0')} /> F</label>
                    </div>
                ))}
            </div>
            <textarea className="st-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="5S Recovery Notes & Fails..." />
            <button type="button" className="st-btn" onClick={submit}>SUBMIT AUDIT</button>
            <hr style={{ borderColor: '#1f3b5c', margin: '15px 0' }} />
            <label className="section-label">EXPORT AUDITS</label>
            <div style={{ display: 'flex', gap: 5, marginBottom: 10 }}>
                <input type="date" className="st-input" style={{ flex: 1, fontSize: '0.8em' }} value={exportStart} onChange={(e) => setExportStart(e.target.value)} />
                <input type="date" className="st-input" style={{ flex: 1, fontSize: '0.8em' }} value={exportEnd} onChange={(e) => setExportEnd(e.target.value)} />
            </div>
            <select className="st-input" value={exportPrem} onChange={(e) => setExportPrem(e.target.value)}>
                <option value="">All Premiums</option>
                <option>Chandler</option>
                <option>Ashley</option>
                <option>Luke</option>
            </select>
            <button type="button" className="st-btn" style={{ borderColor: '#0f8', color: '#0f8', marginBottom: 10 }} onClick={exportAudits}>DOWNLOAD AUDIT CSV</button>
            <button type="button" className="st-btn" style={{ borderColor: '#0cf', color: '#0cf' }} onClick={() => actions.exportWeeklyTrends().then(() => showNotice('Preparing download…', 'info')).catch((e) => showNotice(e.message, 'error'))}>DOWNLOAD WEEKLY TRENDS</button>
        </>
    );
}
