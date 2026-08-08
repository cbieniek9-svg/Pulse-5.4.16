import { useEffect, useState } from 'react';
import { useSync } from '../../../providers/SyncProvider.jsx';
import { useFloorRole } from '../../../hooks/useFloorRole.js';
import { useFloorUi } from '../../shared/NoticeProvider.jsx';

function ClockControls({
    label,
    running,
    stuck,
    canFinish,
    onStart,
    onFinish,
    onReset,
    startLabel,
    finishLabel,
    accent,
}) {
    if (!running && !stuck) {
        return (
            <button type="button" className="st-btn" style={{ borderColor: accent, color: accent }} onClick={onStart}>
                {startLabel}
            </button>
        );
    }
    if (running && !stuck && canFinish) {
        return (
            <button type="button" className="st-btn" style={{ borderColor: '#f90', color: '#f90' }} onClick={onFinish}>
                {finishLabel}
            </button>
        );
    }
    if (running && !stuck) {
        return <span>{label} IN PROGRESS</span>;
    }
    if (stuck && canFinish) {
        return (
            <>
                {label} SAVED / STUCK
                <button type="button" className="st-btn" style={{ borderColor: '#f44', color: '#f44', marginTop: 6 }} onClick={onReset}>
                    ⚠ CLEAR STUCK CLOCKS
                </button>
            </>
        );
    }
    return <span>{label} SAVED</span>;
}

export default function LaborInventoryPanel() {
    const { syncData } = useSync();
    const { canFinishOrder } = useFloorRole();
    const { actions, showNotice } = useFloorUi();
    const counts = syncData?.counts || {};
    const settings = syncData?.settings || {};

    const [groc, setGroc] = useState('');
    const [froz, setFroz] = useState('');
    const [staff, setStaff] = useState('');
    const [frozStaff, setFrozStaff] = useState('');
    const [hdw, setHdw] = useState('');
    const [hdwArr, setHdwArr] = useState(false);

    useEffect(() => {
        setGroc(String(counts.grocery ?? ''));
        setFroz(String(counts.frozen ?? ''));
        setStaff(String(counts.staff ?? ''));
        setFrozStaff(String(counts.frozen_staff ?? counts.staff ?? ''));
        setHdw(String(counts.hardware ?? ''));
        setHdwArr(settings.Hardware_Arrived === '1');
    }, [counts.grocery, counts.frozen, counts.staff, counts.frozen_staff, counts.hardware, settings.Hardware_Arrived]);

    const saveOps = async () => {
        try {
            await actions.updateOpsData({
                grocery: groc,
                frozen: froz,
                staff,
                hardware: hdw,
                frozen_staff: frozStaff,
            });
            showNotice('Saved', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const toggleHdw = async (checked) => {
        setHdwArr(checked);
        try {
            await actions.toggleHardwareArrived(checked);
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const startDry = async () => {
        try {
            const ok = await actions.startOrder();
            if (ok) showNotice('Dry clock started', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const startFrozen = async () => {
        try {
            const ok = await actions.startFrozenOrder();
            if (ok) showNotice('Frozen clock started', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const endDry = async () => {
        try {
            const ok = await actions.endOrder({ clock_kind: 'dry' });
            if (ok) showNotice('Dry order saved', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const endFrozen = async () => {
        try {
            const ok = await actions.endOrder({ clock_kind: 'frozen' });
            if (ok) showNotice('Frozen order saved', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const resetClock = async () => {
        try {
            const ok = await actions.resetOrderClock();
            if (ok) showNotice('Clocks cleared', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const dryRunning = !!settings.Order_Start && !settings.Order_End;
    const dryStuck = !!settings.Order_End;
    const frozRunning = !!settings.Frozen_Order_Start && !settings.Frozen_Order_End;
    const frozStuck = !!settings.Frozen_Order_End;

    return (
        <>
            <div style={{ display: 'flex', gap: 5, marginBottom: 5 }}>
                <input className="st-input" type="number" placeholder="GROC" value={groc} onChange={(e) => setGroc(e.target.value)} title="Dry grocery pieces" />
                <input className="st-input" type="number" placeholder="FROZ" value={froz} onChange={(e) => setFroz(e.target.value)} title="Frozen pieces" />
            </div>
            <div style={{ display: 'flex', gap: 5, marginBottom: 5 }}>
                <input className="st-input" type="number" placeholder="DRY STAFF" value={staff} onChange={(e) => setStaff(e.target.value)} title="Dry crew" />
                <input className="st-input" type="number" placeholder="FROZ STAFF" value={frozStaff} onChange={(e) => setFrozStaff(e.target.value)} title="Frozen crew" />
            </div>
            <div style={{ display: 'flex', gap: 5, marginBottom: 10, alignItems: 'center' }}>
                <input className="st-input" type="number" placeholder="HDW" value={hdw} onChange={(e) => setHdw(e.target.value)} style={{ flex: 1 }} />
                <label style={{ color: '#fff', fontSize: '0.8em', flex: 2, cursor: 'pointer' }}>
                    <input type="checkbox" checked={hdwArr} onChange={(e) => toggleHdw(e.target.checked)} />
                    {' '}Hardware Arrived
                </label>
            </div>
            <button type="button" className="st-btn" onClick={saveOps} style={{ marginBottom: 15 }}>UPDATE LABOR</button>
            <hr style={{ borderColor: '#1f3b5c', margin: '15px 0' }} />
            <div style={{ fontSize: '0.75em', color: '#8aa3b5', marginBottom: 6 }}>
                DRY CLOCK (grocery) — TV ACTUAL PPH still uses this clock the same as before
            </div>
            <div style={{ marginBottom: 12 }}>
                <ClockControls
                    label="DRY"
                    running={dryRunning}
                    stuck={dryStuck}
                    canFinish={canFinishOrder}
                    onStart={startDry}
                    onFinish={endDry}
                    onReset={resetClock}
                    startLabel="▶ START DRY"
                    finishLabel="⏹ FINISH DRY"
                    accent="#0f8"
                />
            </div>
            <div style={{ fontSize: '0.75em', color: '#8aa3b5', marginBottom: 6 }}>
                FROZEN CLOCK — manager data only (not a second TV clock)
            </div>
            <div>
                <ClockControls
                    label="FROZEN"
                    running={frozRunning}
                    stuck={frozStuck}
                    canFinish={canFinishOrder}
                    onStart={startFrozen}
                    onFinish={endFrozen}
                    onReset={resetClock}
                    startLabel="▶ START FROZEN"
                    finishLabel="⏹ FINISH FROZEN"
                    accent="#6cf"
                />
            </div>
        </>
    );
}
