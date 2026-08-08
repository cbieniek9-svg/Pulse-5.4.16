import { useMemo } from 'react';
import { useSync } from '../../../providers/SyncProvider.jsx';
import { useFloorRole } from '../../../hooks/useFloorRole.js';
import { useFloorUi } from '../../shared/NoticeProvider.jsx';
import {
    SCHEDULE_BUCKET_LABELS,
    RHYTHM_SCHEDULE_DEPT_OPTIONS,
    scheduleBucketForShift,
    scheduleDeptValueForShift,
    countScheduleComplement,
    isShiftLeadEligible,
    storeToday,
} from '../../../lib/floorUtils.js';

function ScheduleList({ shifts, canEdit, onOverride }) {
    const buckets = useMemo(() => {
        const b = {};
        shifts.forEach((shift) => {
            const bucket = scheduleBucketForShift(shift);
            if (!b[bucket]) b[bucket] = [];
            b[bucket].push(shift);
        });
        return b;
    }, [shifts]);

    if (!shifts.length) {
        return (
            <div style={{ color: '#b0b0b0', fontSize: '0.85em', padding: '8px 0' }}>
                No imported schedule for today — import in Settings → Staff or leave rhythm tasks Unassigned.
            </div>
        );
    }

    const order = ['supervisor', 'premium', 'rec', 'stock_float', 'bakery', 'cash', 'cs', 'other'];

    return order.filter((key) => buckets[key]?.length).map((key) => (
        <div key={key} style={{ marginBottom: 10, padding: 8, background: 'rgba(0,229,255,0.08)', borderLeft: '3px solid #0cf', color: '#fff', fontSize: '0.85em' }}>
            <div style={{ color: '#0cf', fontSize: '0.75em', marginBottom: 5 }}>{SCHEDULE_BUCKET_LABELS[key] || key}</div>
            {buckets[key].map((s) => {
                const time = `${s.start_time || ''}${s.end_time ? `-${s.end_time}` : ''}`;
                return (
                    <div key={s.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(31,59,92,0.35)' }}>
                        <strong style={{ color: '#fff' }}>{s.staff_name}</strong>
                        {' '}
                        <small>{time}</small>
                        <br />
                        {canEdit ? (
                            <select
                                className="st-input"
                                style={{ width: '100%', marginTop: 4, padding: 4, fontSize: '0.85em' }}
                                value={scheduleDeptValueForShift(s)}
                                onChange={(e) => onOverride(s.id, e.target.value)}
                            >
                                {RHYTHM_SCHEDULE_DEPT_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>
                        ) : (
                            <small style={{ color: '#8cf' }}>{s.department || s.role || 'Scheduled'}</small>
                        )}
                    </div>
                );
            })}
        </div>
    ));
}

export default function ShiftRosterPanel() {
    const { syncData } = useSync();
    const { isManager, isPremium } = useFloorRole();
    const { actions, showNotice } = useFloorUi();

    const staff = syncData?.staff || [];
    const settings = syncData?.settings || {};
    const today = storeToday(syncData);
    // Sync sends today..+14 days for rhythm assign; roster is today only.
    const shiftsToday = useMemo(
        () => (syncData?.staff_shifts || []).filter((s) => s.shift_date === today),
        [syncData?.staff_shifts, today],
    );
    const complement = countScheduleComplement(shiftsToday);
    const canEdit = isManager || isPremium;

    const leadOptions = staff.filter(isShiftLeadEligible).map((s) => s.name);
    const activeMgr = settings.Active_Manager || '';

    const onLeadChange = async (val) => {
        try {
            await actions.setActiveManager(val);
        } catch (e) {
            showNotice('Failed to update shift lead', 'error');
        }
    };

    const onOverride = async (shiftId, department) => {
        try {
            await actions.updateShiftSchedule(shiftId, department);
            showNotice('Schedule role saved — tap Re-apply rhythm if board assignees should refresh', 'success');
        } catch (e) {
            showNotice(e.message || 'Schedule update failed', 'error');
        }
    };

    const reapply = async () => {
        try {
            await actions.reapplyRhythmAssignments();
        } catch (e) {
            showNotice(e.message || 'Re-apply failed', 'error');
        }
    };

    return (
        <>
            <label className="section-label">ACTIVE PREMIUM / SHIFT LEAD</label>
            <select
                className="st-input"
                value={activeMgr}
                disabled={!canEdit}
                onChange={(e) => onLeadChange(e.target.value)}
            >
                <option value="" disabled>Select shift lead</option>
                {leadOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <p style={{ color: '#8cf', fontSize: '0.72em', margin: '8px 0 0', textTransform: 'none' }}>
                Who owns huddle, inbox, and board assignments when leadership is away.
            </p>
            <hr style={{ borderColor: '#1f3b5c', margin: '15px 0' }} />
            <label className="section-label">TODAY&apos;S SCHEDULE</label>
            <div style={{ color: '#0cf', fontSize: '0.82em', marginBottom: 8, textTransform: 'none' }}>
                {complement
                    ? `Total complement today: ${complement}`
                    : 'No imported schedule for today — import in Settings → Staff.'}
            </div>
            <ScheduleList shifts={shiftsToday} canEdit={canEdit} onOverride={onOverride} />
            {canEdit && shiftsToday.length ? (
                <button type="button" className="st-btn" style={{ width: '100%', marginBottom: 10, borderColor: '#0cf', color: '#0cf' }} onClick={reapply}>
                    RE-APPLY RHYTHM ASSIGNMENTS
                </button>
            ) : null}
        </>
    );
}
