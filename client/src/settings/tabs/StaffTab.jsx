import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettings } from '../context/SettingsContext.jsx';
import StatusPill from '../components/StatusPill.jsx';
import {
    RHYTHM_SCHEDULE_DEPT_OPTIONS, SCHEDULE_ROLE_BUCKETS, STAFF_ALIAS_TYPES, STAFF_PERM_KEYS,
    defaultNewStaffPerms, downloadScheduleTemplate, fileToBase64,
    parseJsonSetting, scheduleDeptValueForShift, titleCase, verifySettingsPersisted,
} from '../lib/settingsHelpers.js';
import {
    importStaffSchedule, previewStaffSchedule, removeStaffNameAlias, saveSettingsBatch,
    saveStaffNameAlias, updateStaffShiftRole,
} from '../lib/settingsApi.js';
import { hasPermission, parsePermissionTokens } from '../../lib/permissions.js';

function ScheduleHealthStrip({ health, syncData, onQuickAlias }) {
    if (!health) {
        return <div style={{ color: '#b0b0b0', fontSize: '0.85em' }}>Open Staff tab or refresh to load schedule health.</div>;
    }
    const buckets = Object.entries(health.bucket_counts || {})
        .filter(([, v]) => v.count > 0)
        .map(([k, v]) => `${v.label || k}: ${v.count}`)
        .join(' · ') || 'No rows today';

    return (
        <>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                <StatusPill status={health.status === 'ok' ? 'ok' : (health.status === 'error' ? 'error' : 'warning')} />
                <strong style={{ color: '#fff', textTransform: 'none' }}>Today {health.store_date || syncData?.storeDate || ''}</strong>
                <span style={{ fontSize: '0.78rem', color: '#8cf', textTransform: 'none' }}>
                    {health.focus_shift_count || 0} shifts · complement {health.complement || 0}
                </span>
            </div>
            <div style={{ fontSize: '0.78rem', color: '#8cf', textTransform: 'none', marginBottom: 8 }}>Buckets: {buckets}</div>
            {(health.issues || []).slice(0, 6).map((issue, i) => (
                <div key={i} className="mgr-status-row" style={{ marginTop: 8 }}>
                    <div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <StatusPill status={issue.severity === 'error' ? 'error' : (issue.severity === 'warn' ? 'warning' : 'ok')} />
                            <strong style={{ color: '#fff', fontSize: '0.82rem', textTransform: 'none' }}>{issue.title}</strong>
                        </div>
                        <div style={{ fontSize: '0.78rem', color: '#8cf', marginTop: 4, textTransform: 'none' }}>{issue.detail}</div>
                    </div>
                </div>
            ))}
            {!(health.issues || []).length ? (
                <div style={{ fontSize: '0.82rem', color: '#0f8', textTransform: 'none' }}>Schedule looks good for rhythm auto-assign.</div>
            ) : null}
            {(health.unmatched_names || []).length ? (
                <div style={{ marginTop: 8, fontSize: '0.75rem', color: '#fa0' }}>
                    Quick fix:
                    {health.unmatched_names.slice(0, 4).map((r) => (
                        <button key={r.import_name} type="button" className="st-btn subtle" style={{ width: 'auto', padding: '2px 8px', fontSize: '0.68em', marginRight: 4 }} onClick={() => onQuickAlias(r.import_name)}>
                            + {r.import_name}
                        </button>
                    ))}
                </div>
            ) : null}
        </>
    );
}

export default function StaffTab() {
    const {
        syncData, scheduleHealth, refresh, refreshScheduleHealth, setScheduleHealth,
        showNotice, appConfirm, appPrompt, action, token, user,
    } = useSettings();

    const [profileToggles, setProfileToggles] = useState({
        unassigned: true, scheduleEdit: true,
    });
    const [newStaff, setNewStaff] = useState({ name: '', role: 'Clerk', access: false, perms: defaultNewStaffPerms('Clerk') });
    const [aliasForm, setAliasForm] = useState({ source_name: '', target_name: '', alias_type: 'alias', notes: '' });
    const [roleRules, setRoleRules] = useState([]);
    const [preview, setPreview] = useState(null);
    const [previewFile, setPreviewFile] = useState(null);
    const [importStatus, setImportStatus] = useState('');

    useEffect(() => {
        refreshScheduleHealth().catch(() => {});
    }, [refreshScheduleHealth]);

    useEffect(() => {
        const s = syncData?.settings || {};
        setProfileToggles({
            unassigned: s.Unassigned_Option_Enabled !== '0',
            scheduleEdit: s.Rhythm_Schedule_Edit_Enabled !== '0',
        });
        let rules = parseJsonSetting(s.Schedule_Role_Buckets, []);
        if (!Array.isArray(rules) || !rules.length) {
            rules = [
                { label: 'Receiving (REC)', match: '\\brec\\b|receiv|receiving', bucket: 'rec' },
                { label: 'Bakery', match: 'bakery|bake', bucket: 'bakery' },
                { label: 'Stock / Float / Floor', match: 'stock|float|grocery|aisle|floor', bucket: 'stock_float' },
            ];
        }
        setRoleRules(rules);
    }, [syncData]);

    const staffList = (syncData?.staff || []).filter((s) => s.name !== 'Unassigned');
    const staffNames = staffList.map((s) => s.name);
    const today = syncData?.storeDate || new Date().toISOString().slice(0, 10);
    const shiftsToday = (syncData?.staff_shifts || []).filter((s) => s.shift_date === today);
    const allShifts = syncData?.staff_shifts || [];
    const aliases = syncData?.staff_name_aliases || [];

    const saveProfiles = async (overrides) => {
        const toggles = overrides || profileToggles;
        const unassigned = toggles.unassigned ? '1' : '0';
        const scheduleEdit = toggles.scheduleEdit ? '1' : '0';
        try {
            await saveSettingsBatch([
                { setting_name: 'Unassigned_Option_Enabled', setting_value: unassigned },
                { setting_name: 'Rhythm_Schedule_Edit_Enabled', setting_value: scheduleEdit },
            ], token);
            const data = await refresh();
            if (!verifySettingsPersisted(data, [
                ['Unassigned_Option_Enabled', unassigned],
                ['Rhythm_Schedule_Edit_Enabled', scheduleEdit],
            ])) {
                showNotice('Profile options did not persist.', 'error');
                return;
            }
            showNotice('Profile options saved.', 'success');
        } catch (e) {
            showNotice(`Save failed: ${e.message}`, 'error');
        }
    };

    const onNewStaffRoleChange = (role) => {
        setNewStaff({ ...newStaff, role, perms: defaultNewStaffPerms(role) });
    };

    const addStaff = async () => {
        const n = titleCase(newStaff.name);
        if (!n) {
            showNotice('Please enter a staff name.', 'error');
            return;
        }
        const pin = await appPrompt(`Set an initial PIN for ${n} (min 4 digits):`, '');
        if (!pin || !/^\d{4,}$/.test(pin)) {
            if (pin !== null) showNotice('PIN must be at least 4 digits.', 'error');
            return;
        }
        const perms = newStaff.access
            ? STAFF_PERM_KEYS.filter((k) => newStaff.perms.has(k)).join(',')
            : '';
        try {
            await action('staff', 'insert', {
                name: n, active: 1, pin, app_access: newStaff.access ? 1 : 0, role: newStaff.role, permissions: perms,
            });
            setNewStaff({ name: '', role: 'Clerk', access: false, perms: defaultNewStaffPerms('Clerk') });
            showNotice(`${n} added successfully.`, 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const editStaff = async (id) => {
        const s = syncData?.staff?.find((x) => x.id === id);
        if (!s) return;
        const name = await appPrompt('Edit name:', s.name);
        if (name === null) return;
        const pin = await appPrompt('Edit PIN (leave blank to keep current):', '');
        if (pin === null) return;
        const role = await appPrompt('Edit role (Clerk / Premium Clerk / Manager / Store Manager):', s.role);
        if (role === null) return;
        const data = { name: titleCase(name), role: titleCase(role) };
        if (pin) {
            if (!/^\d{4,}$/.test(pin)) { showNotice('PIN must be at least 4 digits.', 'error'); return; }
            data.pin = pin;
        }
        try {
            await action('staff', 'update', data, 'id', id);
            showNotice('Staff updated.', 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const deleteStaff = async (id) => {
        const s = syncData?.staff?.find((x) => x.id === id);
        if (!s || !(await appConfirm(`Delete ${s.name}? This cannot be undone.`))) return;
        try {
            await action('staff', 'delete', {}, 'id', id);
            showNotice('Staff deleted.', 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const toggleAccess = async (id, access) => {
        try {
            await action('staff', 'update', { app_access: access }, 'id', id);
            await refresh();
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const togglePerm = async (id, perm, val) => {
        const s = syncData?.staff?.find((x) => x.id === id);
        if (!s) return;
        const needle = String(perm || '').trim().toLowerCase();
        let perms = parsePermissionTokens(s.permissions).filter((x) => x !== needle);
        if (val) perms.push(needle);
        try {
            await action('staff', 'update', { permissions: perms.join(',') }, 'id', id);
            await refresh();
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const saveAlias = async () => {
        const source_name = aliasForm.source_name.trim();
        if (!source_name) {
            showNotice('Enter the schedule export name.', 'error');
            return;
        }
        try {
            const result = await saveStaffNameAlias({
                source_name,
                target_name: aliasForm.target_name.trim(),
                alias_type: aliasForm.alias_type,
                notes: aliasForm.notes.trim(),
            }, token);
            if (result.aliases) await refresh();
            setAliasForm({ source_name: '', target_name: '', alias_type: 'alias', notes: '' });
            showNotice('Staff name alias saved.', 'success');
            await refreshScheduleHealth();
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const removeAlias = async (sourceName) => {
        if (!(await appConfirm(`Remove alias for "${sourceName}"?`))) return;
        try {
            await removeStaffNameAlias(sourceName, token);
            showNotice('Alias removed.', 'success');
            await refresh();
            await refreshScheduleHealth();
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const quickAlias = (sourceName) => {
        setAliasForm({ ...aliasForm, source_name: sourceName, alias_type: 'alias' });
        showNotice(`Set app staff for "${sourceName}" and save.`, 'info');
    };

    const saveRoleRules = async () => {
        const rules = roleRules.filter((r) => r.match && r.bucket);
        if (!rules.length) {
            showNotice('At least one role rule is required.', 'error');
            return;
        }
        for (const rule of rules) {
            try {
                RegExp(String(rule.match), 'i');
            } catch (e) {
                showNotice(`Invalid role-rule regex "${rule.label || rule.match}": ${e.message}`, 'error');
                return;
            }
        }
        try {
            await action('settings', 'update', { setting_value: JSON.stringify(rules) }, 'setting_name', 'Schedule_Role_Buckets');
            await refresh();
            showNotice('Schedule role rules saved.', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const previewSchedule = async (file) => {
        if (!file) {
            showNotice('Choose an Excel or CSV schedule first.', 'error');
            return;
        }
        setImportStatus('Analyzing file…');
        try {
            const contentBase64 = await fileToBase64(file);
            setPreviewFile({ filename: file.name, contentBase64 });
            const result = await previewStaffSchedule(file.name, contentBase64, token);
            setPreview(result);
            const skipped = (result.skipped || []).length
                ? ` Skipping ${result.skipped.map((s) => s.staff_name).join(', ')} (not floor staff).`
                : '';
            setImportStatus(result.ready
                ? `Ready to import ${result.shift_count || 0} shifts — review below and confirm.${skipped}`
                : `Fix issues below before importing.${skipped}`);
        } catch (e) {
            setPreview(null);
            setPreviewFile(null);
            setImportStatus(e.message);
            showNotice(e.message, 'error');
        }
    };

    const confirmImport = async () => {
        if (!previewFile?.contentBase64) {
            showNotice('Run preview first.', 'error');
            return;
        }
        setImportStatus('Importing…');
        try {
            const result = await importStaffSchedule(previewFile.filename, previewFile.contentBase64, token);
            const reassigned = result.reassign?.updated ? ` · ${result.reassign.updated} open task(s) reassigned` : '';
            const skipped = (result.skipped || []).length
                ? ` · skipped ${result.skipped.map((s) => s.staff_name).join(', ')} (not floor staff)`
                : '';
            setImportStatus(`Imported ${result.imported || 0} shifts${reassigned}${skipped}`);
            showNotice(`Imported ${result.imported || 0} staff shifts${reassigned}${skipped}`, 'success');
            setPreview(null);
            setPreviewFile(null);
            if (result.health) setScheduleHealth(result.health);
            await refresh();
        } catch (e) {
            setImportStatus(e.message);
            showNotice(e.message, 'error');
        }
    };

    const updateShiftRole = async (shiftId, department) => {
        try {
            await updateStaffShiftRole(shiftId, department, token);
            showNotice('Shift role saved — use Re-apply rhythm on mobile to refresh open assignees', 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message || 'Shift update failed', 'error');
        }
    };

    return (
        <>
            <nav className="mgr-jump-nav" aria-label="Jump to staff section">
                <span className="mgr-jump-nav-label">Jump</span>
                {[
                    ['staff-profiles', 'Profiles'],
                    ['staff-health', 'Health'],
                    ['staff-import', 'Import'],
                    ['staff-buckets', 'Buckets'],
                    ['staff-today', 'Today'],
                    ['staff-upcoming', 'Upcoming'],
                    ['staff-aliases', 'Aliases'],
                    ['staff-add', 'Add'],
                    ['staff-access', 'Access'],
                ].map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        className="mgr-jump-chip"
                        onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    >
                        {label}
                    </button>
                ))}
            </nav>

            <div className="mgr-section-title" id="staff-profiles">SYSTEM PROFILES</div>
            <div className="mgr-card">
                <label style={{ color: '#fff', fontSize: '0.85em', display: 'block', textTransform: 'none' }}>
                    <input type="checkbox" checked={profileToggles.unassigned} onChange={(e) => { const next = { ...profileToggles, unassigned: e.target.checked }; setProfileToggles(next); saveProfiles(next); }} />
                    {' '}Show Unassigned on login screens
                </label>
                <label style={{ color: '#fff', fontSize: '0.85em', display: 'block', marginTop: 10, textTransform: 'none' }}>
                    <input type="checkbox" checked={profileToggles.scheduleEdit} onChange={(e) => { const next = { ...profileToggles, scheduleEdit: e.target.checked }; setProfileToggles(next); saveProfiles(next); }} />
                    {' '}Allow premium shift leads to edit imported schedule roles
                </label>
            </div>

            <div className="mgr-section-title">SCHEDULE &amp; ASSIGNMENTS GUIDE</div>
            <details className="mgr-guide-details mgr-card">
                <summary className="mgr-guide-summary">How schedule, rhythm, and the board fit together</summary>
                <div className="mgr-guide-body">
                    <p className="mgr-hint" style={{ marginTop: 0 }}>
                        <strong>Daily workflow:</strong> Import schedule → confirm shift lead → <strong>Load Daily Rhythm</strong> → fix role tags → <strong>Re-apply</strong> if needed.
                    </p>
                    <button type="button" className="st-btn subtle" style={{ width: 'auto', marginTop: 10 }} onClick={downloadScheduleTemplate}>⬇ DOWNLOAD CSV TEMPLATE</button>
                </div>
            </details>

            <div className="mgr-section-title" id="staff-health">SCHEDULE HEALTH (TODAY)</div>
            <div className="mgr-card" style={{ marginBottom: 16, textTransform: 'none' }}>
                <ScheduleHealthStrip health={scheduleHealth} syncData={syncData} onQuickAlias={quickAlias} />
            </div>

            <div className="mgr-section-title" id="staff-import">IMPORT STAFF SCHEDULE</div>
            <div className="mgr-card">
                <input className="st-input" type="file" accept=".xlsx,.xls,.csv" onChange={(e) => previewSchedule(e.target.files?.[0])} />
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                    <button type="button" className="st-btn subtle" style={{ width: 'auto' }} onClick={downloadScheduleTemplate}>⬇ CSV TEMPLATE</button>
                </div>
                {preview ? (
                    <div style={{ marginTop: 14, textTransform: 'none', border: '1px solid rgba(0,229,255,0.35)', borderRadius: 8, padding: 12 }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                            <StatusPill status={preview.status === 'ok' ? 'ok' : (preview.status === 'error' ? 'error' : 'warning')} />
                            <strong style={{ color: '#fff' }}>{preview.filename || 'Preview'}</strong>
                        </div>
                        <div style={{ fontSize: '0.82rem', color: '#8cf', marginBottom: 8 }}>
                            {preview.shift_count || 0} shifts · today: {preview.focus_shift_count || 0} rows
                        </div>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                            <button type="button" className="st-btn" style={{ width: 'auto', borderColor: '#0f8', color: '#0f8' }} disabled={!preview.ready} onClick={confirmImport}>
                                CONFIRM IMPORT ({preview.shift_count || 0} shifts)
                            </button>
                            <button type="button" className="st-btn subtle" style={{ width: 'auto' }} onClick={() => { setPreview(null); setPreviewFile(null); setImportStatus(''); }}>CANCEL</button>
                        </div>
                    </div>
                ) : null}
                {importStatus ? <div style={{ fontSize: '0.78em', color: '#8cf', marginTop: 10, textTransform: 'none' }}>{importStatus}</div> : null}
            </div>

            <div className="mgr-section-title" id="staff-buckets">SCHEDULE ROLE → TASK BUCKETS</div>
            <div className="mgr-card">
                <table className="mgr-table">
                    <thead><tr><th>Label</th><th>Match (regex)</th><th>Bucket</th></tr></thead>
                    <tbody>
                        {roleRules.map((r, i) => (
                            <tr key={i}>
                                <td><input className="st-input" value={r.label || ''} onChange={(e) => { const next = [...roleRules]; next[i] = { ...next[i], label: e.target.value }; setRoleRules(next); }} /></td>
                                <td><input className="st-input" style={{ textTransform: 'none' }} value={r.match || ''} onChange={(e) => { const next = [...roleRules]; next[i] = { ...next[i], match: e.target.value }; setRoleRules(next); }} /></td>
                                <td>
                                    <select className="st-input" value={r.bucket || 'other'} onChange={(e) => { const next = [...roleRules]; next[i] = { ...next[i], bucket: e.target.value }; setRoleRules(next); }}>
                                        {SCHEDULE_ROLE_BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
                                    </select>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <button type="button" className="st-btn" style={{ width: 'auto', marginBottom: 20, borderColor: '#0f8', color: '#0f8' }} onClick={saveRoleRules}>SAVE ROLE RULES</button>

            <div className="mgr-section-title" id="staff-today">TODAY&apos;S SHIFT ROLES</div>
            <div className="mgr-card">
                {shiftsToday.length ? shiftsToday.map((s) => {
                    const cur = scheduleDeptValueForShift(s);
                    return (
                        <div key={s.id} style={{ padding: '10px 0', borderBottom: '1px solid rgba(31,59,92,0.4)', fontSize: '0.85em' }}>
                            <strong style={{ color: '#fff' }}>{s.staff_name}</strong>
                            <small style={{ color: '#8cf' }}> {s.start_time || ''}{s.end_time ? `-${s.end_time}` : ''}</small>
                            <select className="st-input" style={{ width: '100%', marginTop: 6, padding: 6, fontSize: '0.9em' }} value={cur} onChange={(e) => updateShiftRole(s.id, e.target.value)}>
                                {RHYTHM_SCHEDULE_DEPT_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                            </select>
                        </div>
                    );
                }) : (
                    <div style={{ color: '#b0b0b0', fontSize: '0.85em' }}>No imported shifts for today.</div>
                )}
            </div>

            <div className="mgr-section-title" id="staff-upcoming">UPCOMING IMPORTED SHIFTS (14 DAYS)</div>
            <div className="mgr-card">
                {allShifts.length ? allShifts.map((s) => (
                    <div key={`${s.id}-${s.shift_date}`} style={{ padding: '8px 0', borderBottom: '1px solid rgba(31,59,92,0.4)', fontSize: '0.85em' }}>
                        <strong>{s.shift_date}</strong> {s.start_time || ''}-{s.end_time || ''}<br />
                        <span style={{ color: '#fff' }}>{s.staff_name}</span> <small>{s.department || s.role || ''}</small>
                    </div>
                )) : (
                    <div style={{ color: '#b0b0b0', fontSize: '0.85em' }}>No imported shifts in the next 14 days.</div>
                )}
            </div>

            <div className="mgr-section-title" id="staff-aliases">STAFF NAME ALIASES</div>
            <div className="mgr-card mgr-form-grid" style={{ marginBottom: 12 }}>
                <div>
                    <span className="mgr-field-label">SCHEDULE NAME</span>
                    <input className="st-input" style={{ textTransform: 'none' }} value={aliasForm.source_name} onChange={(e) => setAliasForm({ ...aliasForm, source_name: e.target.value })} />
                </div>
                <div>
                    <span className="mgr-field-label">MAPS TO (APP STAFF)</span>
                    <select className="st-input" value={aliasForm.target_name} disabled={aliasForm.alias_type !== 'alias'} onChange={(e) => setAliasForm({ ...aliasForm, target_name: e.target.value })}>
                        <option value="">— select app staff —</option>
                        {staffNames.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                </div>
                <div>
                    <span className="mgr-field-label">TYPE</span>
                    <select className="st-input" value={aliasForm.alias_type} onChange={(e) => setAliasForm({ ...aliasForm, alias_type: e.target.value, target_name: e.target.value === 'alias' ? aliasForm.target_name : '' })}>
                        {STAFF_ALIAS_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                    <span className="mgr-field-label">NOTES</span>
                    <input className="st-input" style={{ textTransform: 'none' }} value={aliasForm.notes} onChange={(e) => setAliasForm({ ...aliasForm, notes: e.target.value })} />
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                    <button type="button" className="st-btn" style={{ width: 'auto', borderColor: '#0f8', color: '#0f8' }} onClick={saveAlias}>SAVE ALIAS</button>
                </div>
            </div>
            <div className="mgr-card" style={{ marginBottom: 20, textTransform: 'none' }}>
                {aliases.length ? (
                    <table className="mgr-table mgr-guide-table">
                        <thead><tr><th>Schedule name</th><th>Maps to</th><th>Type</th><th>Notes</th><th /></tr></thead>
                        <tbody>
                            {aliases.map((a) => (
                                <tr key={a.source_name}>
                                    <td>{a.source_name}</td>
                                    <td>{a.alias_type === 'alias' && a.target_name ? a.target_name : '—'}</td>
                                    <td>{STAFF_ALIAS_TYPES.find((t) => t.id === a.alias_type)?.label || a.alias_type}</td>
                                    <td>{a.notes || ''}</td>
                                    <td>
                                        <button type="button" className="st-btn subtle" style={{ width: 'auto', padding: '4px 8px', fontSize: '0.72em' }} onClick={() => setAliasForm({ source_name: a.source_name, target_name: a.target_name || '', alias_type: a.alias_type || 'alias', notes: a.notes || '' })}>EDIT</button>
                                        <button type="button" className="st-btn subtle" style={{ width: 'auto', padding: '4px 8px', fontSize: '0.72em', borderColor: '#f66', color: '#f88' }} onClick={() => removeAlias(a.source_name)}>DEL</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <div style={{ color: '#b0b0b0', fontSize: '0.85em' }}>No aliases yet.</div>
                )}
            </div>

            <div className="mgr-section-title" id="staff-add">ADD NEW STAFF</div>
            <div className="mgr-card mgr-form-grid">
                <div>
                    <span className="mgr-field-label">NAME</span>
                    <input className="st-input" value={newStaff.name} onChange={(e) => setNewStaff({ ...newStaff, name: e.target.value })} />
                </div>
                <div>
                    <span className="mgr-field-label">ROLE</span>
                    <select className="st-input" value={newStaff.role} onChange={(e) => onNewStaffRoleChange(e.target.value)}>
                        <option>Clerk</option><option>Premium Clerk</option><option>Manager</option><option>Store Manager</option>
                    </select>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                    <label style={{ color: '#fff', fontSize: '0.82em', textTransform: 'none' }}>
                        <input type="checkbox" checked={newStaff.access} onChange={(e) => setNewStaff({ ...newStaff, access: e.target.checked })} /> Grant mobile login
                    </label>
                </div>
                {newStaff.access ? (
                    <div style={{ gridColumn: '1/-1', display: 'flex', gap: '12px 18px', fontSize: '0.78em', textTransform: 'none', flexWrap: 'wrap' }}>
                        {STAFF_PERM_KEYS.map((k) => (
                            <label key={k}>
                                <input
                                    type="checkbox"
                                    checked={newStaff.perms.has(k)}
                                    onChange={(e) => {
                                        const next = new Set(newStaff.perms);
                                        if (e.target.checked) next.add(k); else next.delete(k);
                                        setNewStaff({ ...newStaff, perms: next });
                                    }}
                                />
                                {' '}
                                {k}
                            </label>
                        ))}
                    </div>
                ) : null}
            </div>
            <button type="button" className="st-btn" style={{ width: 'auto', marginBottom: 20 }} onClick={addStaff}>➕ ADD TO DATABASE</button>

            <div className="mgr-section-title" id="staff-access">ACCESS &amp; PERMISSIONS</div>
            <p className="mgr-hint"><strong>Tasks</strong> = mobile board. <strong>Safe</strong> = <Link to="/safe" style={{ color: '#9c0' }}>/safe</Link>. <strong>Inventory</strong> = <Link to="/count" style={{ color: '#9c0' }}>/count</Link>.</p>
            <div id="staff-list">
                {staffList.map((s) => {
                    const has = (x) => hasPermission(s.permissions, x);
                    return (
                        <div key={s.id} className="mgr-card" style={{ borderLeft: `4px solid ${s.app_access ? '#0f8' : '#555'}` }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                                <div>
                                    <strong style={{ color: '#fff' }}>{s.name}</strong>
                                    {' '}
                                    <small style={{ opacity: 0.7 }}>({s.role || 'Clerk'})</small>
                                </div>
                                <div className="mgr-row-actions">
                                    <button type="button" className="st-btn" style={{ borderColor: '#fa0', color: '#fa0' }} onClick={() => editStaff(s.id)}>EDIT</button>
                                    <button type="button" className="st-btn" style={{ borderColor: '#f33', color: '#f33' }} onClick={() => deleteStaff(s.id)}>DEL</button>
                                    <button type="button" className="st-btn" onClick={() => toggleAccess(s.id, s.app_access ? 0 : 1)}>{s.app_access ? 'REVOKE' : 'GRANT'}</button>
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: 14, fontSize: '0.78em', marginTop: 10, textTransform: 'none', flexWrap: 'wrap' }}>
                                {STAFF_PERM_KEYS.map((k) => (
                                    <label key={k}>
                                        <input type="checkbox" checked={has(k)} onChange={(e) => togglePerm(s.id, k, e.target.checked)} />
                                        {' '}
                                        {k}
                                    </label>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </>
    );
}
