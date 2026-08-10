import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../lib/auth.jsx';
import { useSync } from '../../../providers/SyncProvider.jsx';
import { useFloorUi } from '../../shared/NoticeProvider.jsx';
import { getPremiumZones } from '../../../lib/floorUtils.js';

export default function Core4ZoneCheckPanel() {
    const { user } = useAuth();
    const { syncData } = useSync();
    const { actions, showNotice } = useFloorUi();
    const zones = useMemo(() => getPremiumZones(syncData?.settings), [syncData?.settings]);
    const quickMiss = syncData?.manager_meta?.quick_miss_checks || [];

    const [zone, setZone] = useState(zones[0] || 'Zone 1');
    const [failFront, setFailFront] = useState(false);
    const [failTag, setFailTag] = useState(false);
    const [failHole, setFailHole] = useState(false);
    const [failClear, setFailClear] = useState(false);
    const [notes, setNotes] = useState('');

    useEffect(() => {
        if (!zones.length) return;
        if (!zones.includes(zone)) setZone(zones[0]);
    }, [zones, zone]);

    const submit = async () => {
        if (!zone) {
            showNotice('Select your zone first', 'error');
            return;
        }
        if (!failFront && !failTag && !failHole && !failClear) {
            showNotice('Check at least one Core 4 failure to post recovery tasks', 'error');
            return;
        }
        try {
            await actions.premiumZoneRecovery({
                zone_name: zone,
                premium_name: user,
                front_edge_pass: failFront ? 0 : 1,
                tag_integrity_pass: failTag ? 0 : 1,
                hole_strategy_pass: failHole ? 0 : 1,
                clearances_pass: failClear ? 0 : 1,
                notes,
            });
            setFailFront(false);
            setFailTag(false);
            setFailHole(false);
            setFailClear(false);
            setNotes('');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    return (
        <>
            <p style={{ color: '#8cf', fontSize: '0.72em', margin: '0 0 10px', textTransform: 'none' }}>
                Walk your zone against the Core 4. Mark failures to post High recovery tasks.
            </p>
            <label className="section-label">YOUR ZONE</label>
            <select className="st-input" value={zone} onChange={(e) => setZone(e.target.value)}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
            <label className="section-label" style={{ marginTop: 10 }}>CORE 4 — MARK FAILURES</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10, fontSize: '0.82em', textTransform: 'none' }}>
                <label style={{ color: '#fff' }}><input type="checkbox" checked={failFront} onChange={(e) => setFailFront(e.target.checked)} /> Front-edge</label>
                <label style={{ color: '#fff' }}><input type="checkbox" checked={failTag} onChange={(e) => setFailTag(e.target.checked)} /> Tag integrity</label>
                <label style={{ color: '#fff' }}><input type="checkbox" checked={failHole} onChange={(e) => setFailHole(e.target.checked)} /> Hole strategy</label>
                <label style={{ color: '#fff' }}><input type="checkbox" checked={failClear} onChange={(e) => setFailClear(e.target.checked)} /> Fixture clearances</label>
            </div>
            {quickMiss.length ? (
                <div style={{ fontSize: '0.7em', color: '#8cf', margin: '8px 0 4px', textTransform: 'none' }}>
                    Quick miss checks (from archive)
                    <ul style={{ fontSize: '0.68em', color: '#ccc', textTransform: 'none', margin: '4px 0 8px 18px' }}>
                        {quickMiss.slice(0, 8).map((c, i) => <li key={i}>{c.check}</li>)}
                    </ul>
                </div>
            ) : null}
            <textarea className="st-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What needs recovery? (optional)" />
            <button type="button" className="st-btn" style={{ borderColor: '#0f8', color: '#0f8' }} onClick={submit}>POST RECOVERY TASKS</button>
        </>
    );
}
