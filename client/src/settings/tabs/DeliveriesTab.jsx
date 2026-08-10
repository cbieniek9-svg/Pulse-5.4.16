import { useRef, useState } from 'react';
import { useSettings } from '../context/SettingsContext.jsx';
import { fmtRecvTime, genId, storeDateToday } from '../lib/settingsHelpers.js';
import { postJson } from '../lib/settingsApi.js';

export default function DeliveriesTab() {
    const {
        syncData, action, refresh, showNotice, appConfirm, appPrompt, token, userContext,
    } = useSettings();
    const [adhocVendor, setAdhocVendor] = useState('');
    const [createTask, setCreateTask] = useState(false);
    const [busy, setBusy] = useState(false);
    const operationLock = useRef(false);

    const rows = [...(syncData?.expected || []), ...(syncData?.expected_recent || [])];
    const seen = new Set();
    const unique = rows.filter((e) => {
        if (seen.has(e.exp_id)) return false;
        seen.add(e.exp_id);
        return true;
    });

    const withLock = async (fn) => {
        if (operationLock.current) return;
        operationLock.current = true;
        setBusy(true);
        try {
            await fn();
        } finally {
            operationLock.current = false;
            setBusy(false);
        }
    };

    const markTimeIn = async (expId) => {
        await withLock(async () => {
            if (!(await appConfirm('Log TIME IN for this vendor?'))) return;
            try {
                await postJson('/api/action', {
                    table: 'expected_orders',
                    action: 'receiving_mark_arrived',
                    data: {},
                    id_col: 'exp_id',
                    id_val: expId,
                    userContext,
                }, token);
                showNotice('Time in logged.', 'success');
                await refresh();
            } catch (e) {
                showNotice(e.message, 'error');
            }
        });
    };

    const markTimeOut = async (expId) => {
        await withLock(async () => {
            const row = (syncData?.expected_recent || []).find((e) => e.exp_id === expId)
                || (syncData?.expected || []).find((e) => e.exp_id === expId);
            const onDock = (syncData?.receiving_on_dock || []).find((e) => e.exp_id === expId) || row;
            const isTgp = /^TGP\b/i.test(String(onDock?.vendor || '').trim());
            if (isTgp) {
                if (!onDock?.pallet_count) {
                    showNotice('Log TGP pallets on /rec (Chromebook) before time out.', 'error');
                    return;
                }
                if (!(await appConfirm('Have you finished receiving the truck and all perishable items stored properly?'))) return;
            } else if (!(await appConfirm('Log TIME OUT for this vendor?'))) {
                return;
            }
            let createTaskFlag = '0';
            let startOrderClock = '0';
            if (isTgp) {
                createTaskFlag = (await appConfirm('Post Work the TGP order to All Staff?')) ? '1' : '0';
                if (createTaskFlag === '1') {
                    startOrderClock = (await appConfirm('Also start the order clock? (Skip if already finished today.)')) ? '1' : '0';
                }
            } else {
                createTaskFlag = (await appConfirm('Post work order to the board?')) ? '1' : '0';
            }
            const invoiceRef = String((await appPrompt('Invoice / Ref # (optional):')) || '').trim();
            try {
                await postJson('/api/action', {
                    table: 'expected_orders',
                    action: 'receiving_mark_departed',
                    data: {
                        invoice_ref: invoiceRef,
                        create_task: createTaskFlag,
                        start_order_clock: startOrderClock,
                        storage_confirmed: isTgp ? '1' : undefined,
                    },
                    id_col: 'exp_id',
                    id_val: expId,
                    userContext,
                }, token);
                showNotice('Time out logged.', 'success');
                await refresh();
            } catch (e) {
                showNotice(e.message, 'error');
            }
        });
    };

    const removeDelivery = async (expId) => {
        await withLock(async () => {
            if (!(await appConfirm('Remove this scheduled delivery?'))) return;
            try {
                await action('expected_orders', 'update', { status: 'Archived' }, 'exp_id', expId);
                showNotice('Delivery removed.', 'success');
                await refresh();
            } catch (e) {
                showNotice(e.message, 'error');
            }
        });
    };

    const logAdhoc = async () => {
        await withLock(async () => {
            const vendor = adhocVendor.trim();
            if (!vendor) {
                showNotice('Vendor name is required.', 'error');
                return;
            }
            try {
                await postJson('/api/action', {
                    table: 'expected_orders',
                    action: 'receiving_log_arrival',
                    data: { vendor, create_task: createTask ? '1' : '0', expected_day: storeDateToday(syncData) },
                    userContext,
                }, token);
                setAdhocVendor('');
                showNotice('Unscheduled arrival logged.', 'success');
                await refresh();
            } catch (e) {
                showNotice(e.message, 'error');
            }
        });
    };

    const addScheduled = async () => {
        await withLock(async () => {
            const vendor = await appPrompt('Vendor name:');
            if (!vendor || !vendor.trim()) return;
            try {
                await action('expected_orders', 'insert', {
                    exp_id: genId('E'),
                    vendor: vendor.trim(),
                    expected_day: storeDateToday(syncData),
                    status: 'Pending',
                    logged_by: userContext.name,
                    category: 'general',
                });
                showNotice('Scheduled delivery added.', 'success');
                await refresh();
            } catch (e) {
                showNotice(e.message, 'error');
            }
        });
    };

    return (
        <>
            <div className="mgr-section-title">TODAY&apos;S DELIVERIES</div>
            <p className="mgr-hint">Live receiving board — time vendors in/out and manage scheduled arrivals for today.</p>
            <div className="mgr-card" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                    <span className="mgr-field-label">VENDOR (UNSCHEDULED)</span>
                    <input className="st-input" placeholder="Vendor name" value={adhocVendor} onChange={(e) => setAdhocVendor(e.target.value)} />
                </div>
                <label style={{ fontSize: '0.78em', color: '#aaa', textTransform: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={createTask} onChange={(e) => setCreateTask(e.target.checked)} /> Create work task
                </label>
                <button type="button" className="st-btn" style={{ width: 'auto', borderColor: '#f90', color: '#f90' }} disabled={busy} onClick={logAdhoc}>LOG UNSCHEDULED ARRIVAL</button>
                <button type="button" className="st-btn" style={{ width: 'auto' }} disabled={busy} onClick={addScheduled}>➕ ADD SCHEDULED DELIVERY</button>
            </div>
            <div id="delivery-list">
                {unique.length ? unique.map((e) => {
                    const onDock = e.arrived && !e.departed_at && e.status === 'Arrived';
                    const pending = e.status === 'Pending' && !e.arrived;
                    const timeLine = e.arrived_at ? (
                        <div style={{ fontSize: '0.72em', color: '#8cf', marginTop: 4, textTransform: 'none' }}>
                            IN {fmtRecvTime(e.arrived_at)}
                            {e.departed_at ? ` · OUT ${fmtRecvTime(e.departed_at)}` : ''}
                            {' · '}
                            {e.arrived_by || e.departed_by || ''}
                        </div>
                    ) : null;
                    return (
                        <div key={e.exp_id} className="mgr-card" style={{ borderLeft: `4px solid ${onDock ? '#0f8' : '#f90'}` }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                                <div>
                                    <strong style={{ color: '#fff' }}>{e.vendor}</strong>
                                    {' '}
                                    <span style={{ color: '#8cf' }}>({e.status})</span>
                                    {timeLine}
                                </div>
                                <div>
                                    {pending ? (
                                        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                                            <button type="button" className="st-btn" style={{ width: 'auto', padding: '4px 12px', fontSize: '0.78em', borderColor: '#0f8', color: '#0f8' }} disabled={busy} onClick={() => markTimeIn(e.exp_id)}>TIME IN</button>
                                            <button type="button" className="st-btn" style={{ width: 'auto', padding: '4px 12px', fontSize: '0.78em', borderColor: '#f33', color: '#f33' }} disabled={busy} onClick={() => removeDelivery(e.exp_id)}>REMOVE</button>
                                        </div>
                                    ) : null}
                                    {onDock ? (
                                        <button type="button" className="st-btn" style={{ width: 'auto', padding: '4px 12px', fontSize: '0.78em', borderColor: '#8cf', color: '#8cf', marginTop: 8 }} disabled={busy} onClick={() => markTimeOut(e.exp_id)}>TIME OUT</button>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    );
                }) : (
                    <div className="mgr-card" style={{ color: '#b0b0b0', textAlign: 'center' }}>No deliveries logged for today.</div>
                )}
            </div>
        </>
    );
}
