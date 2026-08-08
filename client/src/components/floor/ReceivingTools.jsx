import { memo, useState } from 'react';
import { useFloorRole } from '../../hooks/useFloorRole.js';
import { useFloorUi } from '../shared/NoticeProvider.jsx';
import { storeToday } from '../../lib/floorUtils.js';
import { useSync } from '../../providers/SyncProvider.jsx';

function ReceivingToolsInner() {
    const { syncData } = useSync();
    const { showReceiving, showPremOnly } = useFloorRole();
    const { actions, showNotice, appPrompt, appConfirm } = useFloorUi();
    const [logDate, setLogDate] = useState(() => storeToday(syncData));

    if (!showReceiving) return null;

    const logAdhoc = async () => {
        const vendor = await appPrompt('Vendor name (unscheduled arrival):');
        if (!vendor?.trim()) return;
        const createTask = await appConfirm('Create receiving work task for this vendor?');
        try {
            await actions.logAdhocArrival(vendor, createTask);
            showNotice('Time in logged', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    return (
        <>
            <div style={{ marginBottom: 12, padding: 10, border: '1px solid #1f3b5c', borderRadius: 4 }}>
                <label className="section-label">PRINT REC LOG (BY DAY)</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input type="date" className="st-input" style={{ flex: 1, minWidth: 140, margin: 0, textTransform: 'none' }} value={logDate} onChange={(e) => setLogDate(e.target.value)} />
                    <button type="button" className="st-btn" style={{ width: 'auto', padding: '8px 12px', borderColor: '#0cf', color: '#0cf' }} onClick={() => actions.exportReceivingLog(logDate, 'print').catch((e) => showNotice(e.message, 'error'))}>PRINT</button>
                    <button type="button" className="st-btn" style={{ width: 'auto', padding: '8px 12px', borderColor: '#8cf', color: '#8cf' }} onClick={() => actions.exportReceivingLog(logDate, 'csv').catch((e) => showNotice(e.message, 'error'))}>CSV</button>
                </div>
            </div>
            <button type="button" className="st-btn" style={{ borderColor: '#f90', color: '#f90', marginBottom: 20 }} onClick={logAdhoc}>LOG UNSCHEDULED ARRIVAL</button>
            {showPremOnly ? (
                <div style={{ marginTop: 30 }}>
                    <hr style={{ borderColor: '#1f3b5c', margin: '20px 0' }} />
                    <button type="button" className="st-btn" style={{ background: 'rgba(255,255,255,0.1)', color: '#fff', padding: 15, fontSize: '1.1em', borderColor: '#a855f7' }} onClick={() => actions.loadRhythm()}>
                        LOAD DAILY RHYTHM
                    </button>
                </div>
            ) : null}
        </>
    );
}

export default memo(ReceivingToolsInner);
