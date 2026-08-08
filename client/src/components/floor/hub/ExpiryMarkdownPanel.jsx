import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useSync } from '../../../providers/SyncProvider.jsx';
import { useFloorUi } from '../../shared/NoticeProvider.jsx';
import {
    addDaysStamp, expiryDaysUntil, isActiveKillRow, mgrKillZoneOwner, storeToday,
} from '../../../lib/floorUtils.js';

function KillRowActions({ id, killDate, today, onSold, onPulled }) {
    const du = expiryDaysUntil(killDate, today);
    return (
        <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {du != null && du <= 0 ? (
                <button type="button" className="st-btn" style={{ width: 'auto', padding: '2px 8px', fontSize: '0.65em', borderColor: '#0f8', color: '#0f8' }} onClick={() => onPulled(id)}>PULLED</button>
            ) : null}
            <button type="button" className="st-btn subtle" style={{ width: 'auto', padding: '2px 8px', fontSize: '0.65em' }} onClick={() => onSold(id)}>SOLD THROUGH</button>
        </div>
    );
}

function ExpiryCalendar({ syncData, onSold, onPulled }) {
    const today = storeToday(syncData);
    const warnEnd = addDaysStamp(today, 7);
    const monthEnd = addDaysStamp(today, 30);
    const active = (syncData?.kill_dates || []).filter(isActiveKillRow);

    const groups = useMemo(() => {
        const pull = [];
        const week = [];
        const month = [];
        active.forEach((k) => {
            const kd = k.kill_date || '';
            if (!kd) return;
            const row = { ...k, days_until: expiryDaysUntil(kd, today) };
            if (kd <= today) pull.push(row);
            else if (kd <= warnEnd) week.push(row);
            else if (kd <= monthEnd) month.push(row);
        });
        const sortRows = (rows) => rows.sort((a, b) => (a.kill_date || '').localeCompare(b.kill_date || '') || (a.zone || '').localeCompare(b.zone || ''));
        sortRows(pull); sortRows(week); sortRows(month);
        return { pull, week, month };
    }, [active, today, warnEnd, monthEnd]);

    const section = (title, color, rows) => {
        if (!rows.length) return <div style={{ opacity: 0.65, fontSize: '0.8em', margin: '8px 0' }}>{title}: none</div>;
        const byZone = {};
        rows.forEach((r) => {
            const z = r.zone || 'General';
            if (!byZone[z]) byZone[z] = [];
            byZone[z].push(r);
        });
        return (
            <div style={{ marginBottom: 12 }}>
                <div style={{ margin: '10px 0 6px', fontWeight: 'bold', color, fontSize: '0.8em' }}>{title} ({rows.length})</div>
                {Object.entries(byZone).sort(([a], [b]) => a.localeCompare(b)).map(([z, items]) => (
                    <div key={z} style={{ marginBottom: 8, padding: '6px 8px', background: 'rgba(0,0,0,0.25)', borderLeft: `3px solid ${color}` }}>
                        <div style={{ fontSize: '0.75em', color, marginBottom: 4 }}>
                            {z}{mgrKillZoneOwner(z, syncData?.settings) ? ` · ${mgrKillZoneOwner(z, syncData?.settings)}` : ''}
                        </div>
                        {items.map((r) => (
                            <div key={r.id} style={{ fontSize: '0.8em', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                                <strong>{r.item}</strong>
                                <br />
                                <small style={{ opacity: 0.85 }}>{r.zone} · {r.kill_date}{r.days_until != null ? ` · ${r.days_until}D` : ''}</small>
                                <KillRowActions id={r.id} killDate={r.kill_date} today={today} onSold={onSold} onPulled={onPulled} />
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        );
    };

    return (
        <>
            {section('PULL TODAY', '#f44', groups.pull)}
            {section('NEXT 7 DAYS', '#f90', groups.week)}
            {section('NEXT 30 DAYS', '#8cf', groups.month)}
        </>
    );
}

export default function ExpiryMarkdownPanel() {
    const { syncData } = useSync();
    const { actions, showNotice } = useFloorUi();
    const today = storeToday(syncData);
    const rows = (syncData?.kill_dates || []).filter(isActiveKillRow).slice(0, 40);
    const archiveCount = syncData?.markdown_archive_count;

    return (
        <>
            <p style={{ margin: '0 0 10px', fontSize: '0.85em', color: '#c7d7ec', textTransform: 'none' }}>
                Staff log FIFO expiry rows in the Markdown / Expiry portal. Use SOLD THROUGH when an item sells before its pull date.
            </p>
            <label className="section-label">EXPIRY CALENDAR (BY ZONE)</label>
            <div style={{ marginBottom: 12 }}>
                <ExpiryCalendar
                    syncData={syncData}
                    onSold={(id) => actions.markKillResolved(id, 'sold')}
                    onPulled={(id) => actions.markKillResolved(id, 'pulled')}
                />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <button type="button" className="st-btn" style={{ width: 'auto', padding: '8px 14px', fontSize: '0.78em', borderColor: '#8cf', color: '#8cf' }} onClick={() => actions.exportKillDatePullList('print').catch((e) => showNotice(e.message, 'error'))}>🖨 PRINT PULL LIST</button>
                <button type="button" className="st-btn subtle" style={{ width: 'auto', padding: '8px 14px', fontSize: '0.78em' }} onClick={() => actions.exportKillDatePullList('csv').catch((e) => showNotice(e.message, 'error'))}>📥 CSV (PULL + 7 DAY)</button>
            </div>
            <label className="section-label">ACTIVE EXPIRY / MARKDOWN RECORDS</label>
            <div style={{ marginBottom: 8 }}>
                {rows.length ? rows.map((k) => {
                    const owner = mgrKillZoneOwner(k.zone, syncData?.settings);
                    const du = expiryDaysUntil(k.kill_date, today);
                    return (
                        <div key={k.id} style={{ background: 'rgba(168,85,247,0.12)', padding: 8, marginBottom: 5, borderLeft: '3px solid #a855f7', fontSize: '0.85em' }}>
                            <strong>{k.item}</strong>{k.item_code ? ` (${k.item_code})` : ''}
                            <br />
                            <small>{k.zone} · {k.kill_date}{du != null ? ` · ${du}D` : ''}{owner ? ` · ${owner}` : ''}</small>
                            <KillRowActions id={k.id} killDate={k.kill_date} today={today} onSold={(id) => actions.markKillResolved(id, 'sold')} onPulled={(id) => actions.markKillResolved(id, 'pulled')} />
                        </div>
                    );
                }) : <span style={{ opacity: 0.7 }}>No active expiry records.</span>}
            </div>
            {typeof archiveCount === 'number' ? (
                <p style={{ margin: '8px 0 6px', fontSize: '0.75em', color: '#888' }}>
                    {archiveCount ? `${archiveCount} archived markdown row${archiveCount === 1 ? '' : 's'} in database (not on live board).` : 'No archived markdown rows in database.'}
                </p>
            ) : null}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <Link
                    to="/markdown"
                    className="st-btn"
                    style={{ width: 'auto', padding: '8px 14px', fontSize: '0.78em', borderColor: '#a855f7', color: '#c9a0ff', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                >
                    OPEN FIFO SCAN (CAMERA)
                </Link>
                <Link
                    to="/markdown?tab=archive"
                    className="st-btn"
                    style={{ width: 'auto', padding: '8px 14px', fontSize: '0.78em', borderColor: '#8cf', color: '#8cf', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                >
                    BROWSE FULL ARCHIVE
                </Link>
            </div>
            <button type="button" className="st-btn" style={{ background: '#633', borderColor: '#844' }} onClick={() => actions.clearMarkdownArchive()}>CLEAR MARKDOWN ARCHIVE</button>
        </>
    );
}
