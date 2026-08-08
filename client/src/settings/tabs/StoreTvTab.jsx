import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettings } from '../context/SettingsContext.jsx';
import {
    MAP_SECTIONS, parseFifoAssignments, parseJsonSetting, settingIsEnabled, verifySettingsPersisted,
} from '../lib/settingsHelpers.js';
import { apiAction, saveSettingsBatch, updateFinancialLogShadowSettings } from '../lib/settingsApi.js';

function buildInitialForm(syncData) {
    const s = syncData?.settings || {};
    const store = syncData?.store || {};
    const names = parseJsonSetting(s.Zone_Names, {});
    const owners = parseJsonSetting(s.Zone_Ownership, {});
    const mapping = parseJsonSetting(s.Zone_Mapping, {});
    const labels = parseJsonSetting(s.Zone_Section_Labels, {});
    const secToZone = {};
    Object.entries(mapping).forEach(([zone, ids]) => (ids || []).forEach((id) => { secToZone[id] = zone; }));

    const csFullOn = s.Cs_Full_Enabled === '1' || (s.Cs_Full_Enabled !== '0' && s.Betacs_Enabled === '1');

    return {
        storeCode: s.Store_Code || store.code || '',
        displayName: s.Store_Display_Name || store.displayName || '',
        timezone: s.Store_Timezone || store.timezone || '',
        tvScale: s.TV_Scale || '1.0',
        tvCols: s.TV_Col_Split || '2,1,1',
        tvKpiSize: s.TV_KPI_Size || '1.0',
        tvMapSize: s.TV_Map_Size || '1.0',
        tvNative: s.TV_Native_Shell === '1',
        tvShowPinnedHuddle: settingIsEnabled(s, 'TV_Show_Pinned_Daily_Huddle', false),
        tvShowStoreComms: settingIsEnabled(s, 'TV_Show_Store_Comms', true),
        tvShowAuditTrail: settingIsEnabled(s, 'TV_Show_Audit_Trail', true),
        tvShowTicker: settingIsEnabled(s, 'TV_Show_Ticker', false),
        tvShowLatestShiftUpdate: settingIsEnabled(s, 'TV_Show_Latest_Shift_Update', false),
        csFullEnabled: csFullOn,
        csHubEnabled: s.Cs_Hub_Enabled === '1',
        csCrmEnabled: s.Cs_Crm_Enabled === '1',
        inventoryCountEnabled: s.Inventory_Count_Enabled === '1',
        storeTransfersEnabled: s.Store_Transfers_Enabled === '1',
        financialLogShadowEnabled: settingIsEnabled(s, 'Financial_Log_Shadow_Mode', true),
        financialLogShadowAllowlist: s.Financial_Log_Shadow_Allowlist || '',
        zoneNames: {
            zone1: names['Zone 1'] || '',
            zone2: names['Zone 2'] || '',
            zone3: names['Zone 3'] || '',
            zone4: names['Zone 4'] || '',
        },
        zoneOwners: {
            zone1: owners['Zone 1'] || '',
            zone2: owners['Zone 2'] || '',
            zone3: owners['Zone 3'] || '',
            zone4: owners['Zone 4'] || '',
        },
        sectionZones: Object.fromEntries(MAP_SECTIONS.map((id) => [id, secToZone[id] || 'Zone 1'])),
        sectionLabels: Object.fromEntries(MAP_SECTIONS.map((id) => [id, {
            label: labels[id]?.label || '',
            sublabel: labels[id]?.sublabel || '',
        }])),
        fifoRows: parseFifoAssignments(s),
    };
}

export default function StoreTvTab() {
    const { syncData, refresh, showNotice, appConfirm, token, user } = useSettings();
    const [form, setForm] = useState(() => buildInitialForm(syncData));

    useEffect(() => {
        if (syncData) setForm(buildInitialForm(syncData));
    }, [syncData]);

    const staffNames = useMemo(
        () => (syncData?.staff || []).filter((s) => s.active).map((s) => s.name),
        [syncData],
    );

    const csHint = useMemo(() => {
        const s = syncData?.settings || {};
        const hubOn = s.Cs_Hub_Enabled === '1';
        const csFullOn = form.csFullEnabled;
        const crmOn = s.Cs_Crm_Enabled === '1';
        if (hubOn && csFullOn && crmOn) return 'Hub + CS_Full + CRM ON — /cs has Customers (profiles), Due/pickups, and CS_Full.';
        if (hubOn && csFullOn) return 'CS hub ON + CS_Full ON — open /cs, log in, use hub buttons.';
        if (hubOn) return 'CS hub ON — /cs shows login + hub; enable CS_Full for the full order board.';
        if (csFullOn) return 'CS_Full is ON (no hub) — /cs shows the CS_Full log + board.';
        return 'CS_Full is OFF — /cs uses the legacy one-line order form until you enable CS_Full here.';
    }, [syncData, form.csFullEnabled]);

    const saveCsFull = async (checked) => {
        setForm({ ...form, csFullEnabled: checked });
        try {
            const val = checked ? '1' : '0';
            await apiAction({ table: 'settings', action: 'update', data: { setting_value: val }, id_col: 'setting_name', id_val: 'Cs_Full_Enabled', token, user });
            await apiAction({ table: 'settings', action: 'update', data: { setting_value: val }, id_col: 'setting_name', id_val: 'Betacs_Enabled', token, user });
            await refresh();
            showNotice(checked ? 'CS_Full enabled — open or refresh /cs to test.' : 'CS_Full disabled.', 'success');
        } catch (e) {
            showNotice(`CS_Full save failed: ${e.message}`, 'error');
        }
    };

    const saveImmediateToggle = async (field, settingName, messages) => {
        const prev = form[field];
        const next = !prev;
        setForm({ ...form, [field]: next });
        try {
            await apiAction({
                table: 'settings', action: 'update', data: { setting_value: next ? '1' : '0' }, id_col: 'setting_name', id_val: settingName, token, user,
            });
            await refresh();
            showNotice(next ? messages.on : messages.off, 'success');
        } catch (e) {
            setForm({ ...form, [field]: prev });
            showNotice(`${messages.err}: ${e.message}`, 'error');
        }
    };

    const saveFinancialLogShadowMode = async (checked) => {
        if (!checked && !(await appConfirm('Turn off shadow mode? All managers will see Financial Log in the Management Hub.'))) {
            return;
        }
        const prev = form.financialLogShadowEnabled;
        setForm({ ...form, financialLogShadowEnabled: checked });
        try {
            await updateFinancialLogShadowSettings(token, { shadow_mode: checked });
            await refresh();
            showNotice(
                checked
                    ? 'Financial Log shadow mode enabled — only allowlisted managers can open /financial.'
                    : 'Financial Log shadow mode disabled — all managers can access /financial.',
                'success',
            );
        } catch (e) {
            setForm({ ...form, financialLogShadowEnabled: prev });
            showNotice(e.message || 'Shadow mode save failed.', 'error');
        }
    };

    const saveFinancialLogAllowlist = async () => {
        try {
            await updateFinancialLogShadowSettings(token, { allowlist: form.financialLogShadowAllowlist });
            await refresh();
            showNotice('Financial Log shadow allowlist saved.', 'success');
        } catch (e) {
            showNotice(e.message || 'Allowlist save failed.', 'error');
        }
    };

    const clearFinancialLogAllowlist = async () => {
        if (!(await appConfirm('Clear the allowlist? The next manager to open /financial can claim shadow access again.'))) {
            return;
        }
        setForm({ ...form, financialLogShadowAllowlist: '' });
        try {
            await updateFinancialLogShadowSettings(token, { allowlist: '' });
            await refresh();
            showNotice('Financial Log shadow allowlist cleared.', 'success');
        } catch (e) {
            showNotice(e.message || 'Allowlist clear failed.', 'error');
        }
    };

    const addFifoRow = () => {
        setForm({ ...form, fifoRows: [...form.fifoRows, { staff: '', aisles: [] }] });
    };

    const updateFifoRow = (idx, patch) => {
        const rows = [...form.fifoRows];
        rows[idx] = { ...rows[idx], ...patch };
        setForm({ ...form, fifoRows: rows });
    };

    const removeFifoRow = (idx) => {
        setForm({ ...form, fifoRows: form.fifoRows.filter((_, i) => i !== idx) });
    };

    const collectFifo = () => form.fifoRows.map((row) => {
        const aislesRaw = Array.isArray(row.aisles) ? row.aisles.join(', ') : (row.aislesRaw || '');
        const aisles = String(aislesRaw).split(/[,·|/]+/).map((s) => s.trim()).filter(Boolean);
        return { staff: (row.staff || '').trim(), aisles };
    }).filter((r) => r.staff && r.aisles.length);

    const saveAll = async () => {
        const zoneNames = {
            'Zone 1': (form.zoneNames.zone1 || 'ZONE 1').toUpperCase(),
            'Zone 2': (form.zoneNames.zone2 || 'ZONE 2').toUpperCase(),
            'Zone 3': (form.zoneNames.zone3 || 'ZONE 3').toUpperCase(),
            'Zone 4': (form.zoneNames.zone4 || 'ZONE 4').toUpperCase(),
        };
        const zoneMapping = { 'Zone 1': [], 'Zone 2': [], 'Zone 3': [], 'Zone 4': ['map-cmd'] };
        MAP_SECTIONS.forEach((id) => {
            const v = form.sectionZones[id];
            if (v && zoneMapping[v]) zoneMapping[v].push(id);
        });
        const zoneOwnership = {
            'Zone 1': form.zoneOwners.zone1 || '',
            'Zone 2': form.zoneOwners.zone2 || '',
            'Zone 3': form.zoneOwners.zone3 || '',
            'Zone 4': form.zoneOwners.zone4 || '',
        };
        const zoneLabels = {};
        MAP_SECTIONS.forEach((id) => {
            zoneLabels[id] = {
                label: (form.sectionLabels[id]?.label || '').toUpperCase(),
                sublabel: (form.sectionLabels[id]?.sublabel || '').toUpperCase(),
            };
        });
        zoneLabels['map-a5'] = {
            ...zoneLabels['map-a5'],
            sections: [
                { label: 'Coffee', owner: 'Ashley' },
                { label: 'Monin/Torani', owner: 'Luke' },
                { label: 'Wraps', owner: 'Chandler' },
            ],
        };

        try {
            await saveSettingsBatch([
                { setting_name: 'Store_Code', setting_value: form.storeCode.trim().toUpperCase() },
                { setting_name: 'Store_Display_Name', setting_value: form.displayName.trim() },
                { setting_name: 'Store_Timezone', setting_value: form.timezone.trim() },
                { setting_name: 'TV_Scale', setting_value: form.tvScale || '1.0' },
                { setting_name: 'TV_Col_Split', setting_value: form.tvCols || '2,1,1' },
                { setting_name: 'TV_KPI_Size', setting_value: form.tvKpiSize || '1.0' },
                { setting_name: 'TV_Map_Size', setting_value: form.tvMapSize || '1.0' },
                { setting_name: 'TV_Native_Shell', setting_value: form.tvNative ? '1' : '0' },
                { setting_name: 'TV_Show_Pinned_Daily_Huddle', setting_value: form.tvShowPinnedHuddle ? '1' : '0' },
                { setting_name: 'TV_Show_Store_Comms', setting_value: form.tvShowStoreComms ? '1' : '0' },
                { setting_name: 'TV_Show_Audit_Trail', setting_value: form.tvShowAuditTrail ? '1' : '0' },
                { setting_name: 'TV_Show_Ticker', setting_value: form.tvShowTicker ? '1' : '0' },
                { setting_name: 'TV_Show_Latest_Shift_Update', setting_value: form.tvShowLatestShiftUpdate ? '1' : '0' },
                { setting_name: 'Cs_Full_Enabled', setting_value: form.csFullEnabled ? '1' : '0' },
                { setting_name: 'Betacs_Enabled', setting_value: form.csFullEnabled ? '1' : '0' },
                { setting_name: 'Cs_Hub_Enabled', setting_value: form.csHubEnabled ? '1' : '0' },
                { setting_name: 'Cs_Crm_Enabled', setting_value: form.csCrmEnabled ? '1' : '0' },
                { setting_name: 'Inventory_Count_Enabled', setting_value: form.inventoryCountEnabled ? '1' : '0' },
                { setting_name: 'Store_Transfers_Enabled', setting_value: form.storeTransfersEnabled ? '1' : '0' },
                { setting_name: 'Zone_Names', setting_value: JSON.stringify(zoneNames) },
                { setting_name: 'Zone_Mapping', setting_value: JSON.stringify(zoneMapping) },
                { setting_name: 'Zone_Ownership', setting_value: JSON.stringify(zoneOwnership) },
                { setting_name: 'Zone_Section_Labels', setting_value: JSON.stringify(zoneLabels) },
                { setting_name: 'FIFO_Aisle_Assignments', setting_value: JSON.stringify(collectFifo()) },
            ], token);
            const data = await refresh();
            const csFullWant = form.csFullEnabled ? '1' : '0';
            if (!verifySettingsPersisted(data || syncData, [
                ['Store_Code', form.storeCode.trim().toUpperCase()],
                ['TV_Show_Ticker', form.tvShowTicker ? '1' : '0'],
                ['TV_Show_Store_Comms', form.tvShowStoreComms ? '1' : '0'],
                ['Cs_Full_Enabled', csFullWant],
            ])) {
                showNotice('Setting did not persist — confirm manager login and retry.', 'error');
                return;
            }
            showNotice('Store & TV settings saved.', 'success');
        } catch (e) {
            showNotice(`Save failed: ${e.message}`, 'error');
        }
    };

    return (
        <>
            <div className="mgr-section-title">STORE IDENTITY</div>
            <div className="mgr-form-grid-2 mgr-card">
                <div>
                    <span className="mgr-field-label">STORE CODE</span>
                    <input className="st-input" value={form.storeCode} onChange={(e) => setForm({ ...form, storeCode: e.target.value })} placeholder="STORE-001" />
                </div>
                <div>
                    <span className="mgr-field-label">TIMEZONE (IANA)</span>
                    <input className="st-input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="America/Toronto" />
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                    <span className="mgr-field-label">DISPLAY NAME</span>
                    <input className="st-input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="TGP Center Store" />
                </div>
            </div>

            <div className="mgr-section-title">TV DISPLAY</div>
            <div className="mgr-form-grid-2 mgr-card">
                <div>
                    <span className="mgr-field-label">VIEWPORT SCALE (0.5 – 2.0)</span>
                    <input className="st-input" type="number" step={0.05} min={0.4} max={2} value={form.tvScale} onChange={(e) => setForm({ ...form, tvScale: e.target.value })} />
                </div>
                <div>
                    <span className="mgr-field-label">COLUMN LAYOUT</span>
                    <select className="st-input" value={form.tvCols} onChange={(e) => setForm({ ...form, tvCols: e.target.value })}>
                        <option value="2,1,1">Wide Tasks (default)</option>
                        <option value="1.5,1,1">Balanced</option>
                        <option value="1,1,1">Equal Thirds</option>
                        <option value="2,1.5,1.5">Wide Orders</option>
                    </select>
                </div>
                <div>
                    <span className="mgr-field-label">KPI TILE SIZE {form.tvKpiSize}×</span>
                    <input className="st-input" type="range" min={0.7} max={1.5} step={0.05} value={form.tvKpiSize} style={{ padding: 4 }} onChange={(e) => setForm({ ...form, tvKpiSize: e.target.value })} />
                </div>
                <div>
                    <span className="mgr-field-label">MAP SIZE {form.tvMapSize}×</span>
                    <input className="st-input" type="range" min={0.5} max={2} step={0.1} value={form.tvMapSize} style={{ padding: 4 }} onChange={(e) => setForm({ ...form, tvMapSize: e.target.value })} />
                </div>
                <label style={{ gridColumn: '1/-1', fontSize: '0.8em', color: '#c7d7ec', textTransform: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={form.tvNative} onChange={(e) => setForm({ ...form, tvNative: e.target.checked })} /> Use native TV dashboard (default)
                </label>
                <div style={{ gridColumn: '1/-1', borderTop: '1px solid rgba(31,59,92,0.65)', paddingTop: 10, marginTop: 4 }}>
                    <div className="mgr-field-label" style={{ marginBottom: 8 }}>TV DISPLAY TOGGLES</div>
                    <div className="mgr-form-grid-2" style={{ gap: 8 }}>
                        {[
                            ['tvShowPinnedHuddle', 'Show legacy pinned messages'],
                            ['tvShowStoreComms', 'Show Store Comms feed panel'],
                            ['tvShowAuditTrail', 'Show auto/audit trail items'],
                            ['tvShowTicker', 'Show legacy bottom ticker'],
                            ['tvShowLatestShiftUpdate', 'Show Shift Updates in legacy feed'],
                        ].map(([key, label]) => (
                            <label key={key} style={{ fontSize: '0.8em', color: '#c7d7ec', textTransform: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                                <input type="checkbox" checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} />
                                {label}
                            </label>
                        ))}
                    </div>
                </div>
                <label style={{ gridColumn: '1/-1', fontSize: '0.8em', color: '#c7d7ec', textTransform: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={form.csFullEnabled} onChange={(e) => saveCsFull(e.target.checked)} />
                    Enable CS_Full on <Link to="/cs" target="_blank" rel="noopener" style={{ color: '#0cf' }}>/cs</Link> (saves immediately)
                </label>
                <label style={{ gridColumn: '1/-1', fontSize: '0.8em', color: '#c7d7ec', textTransform: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={form.csHubEnabled} onChange={() => saveImmediateToggle('csHubEnabled', 'Cs_Hub_Enabled', { on: 'CS module hub enabled.', off: 'CS module hub disabled.', err: 'CS hub save failed' })} />
                    CS module hub (saves immediately)
                </label>
                <label style={{ gridColumn: '1/-1', fontSize: '0.8em', color: '#c7d7ec', textTransform: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={form.csCrmEnabled} onChange={() => saveImmediateToggle('csCrmEnabled', 'Cs_Crm_Enabled', { on: 'CS customer CRM enabled.', off: 'CS customer CRM disabled.', err: 'CS CRM save failed' })} />
                    CS customer CRM (saves immediately)
                </label>
                <label style={{ gridColumn: '1/-1', fontSize: '0.8em', color: '#c7d7ec', textTransform: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={form.inventoryCountEnabled} onChange={() => saveImmediateToggle('inventoryCountEnabled', 'Inventory_Count_Enabled', { on: 'Inventory count enabled.', off: 'Inventory count disabled.', err: 'Inventory count save failed' })} />
                    Enable inventory count on <Link to="/count" target="_blank" rel="noopener" style={{ color: '#0cf' }}>/count</Link>
                </label>
                <label style={{ gridColumn: '1/-1', fontSize: '0.8em', color: '#c7d7ec', textTransform: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={form.storeTransfersEnabled} onChange={() => saveImmediateToggle('storeTransfersEnabled', 'Store_Transfers_Enabled', { on: 'Store Transfers enabled.', off: 'Store Transfers disabled.', err: 'Store transfers save failed' })} />
                    Enable Store Transfers on <Link to="/rec" target="_blank" rel="noopener" style={{ color: '#0cf' }}>/rec</Link>
                </label>
                <div style={{ gridColumn: '1/-1', borderTop: '1px solid rgba(31,59,92,0.65)', paddingTop: 10, marginTop: 4 }}>
                    <div className="mgr-field-label" style={{ marginBottom: 8 }}>FINANCIAL LOG</div>
                    <label style={{ fontSize: '0.8em', color: '#c7d7ec', textTransform: 'none', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <input
                            type="checkbox"
                            checked={form.financialLogShadowEnabled}
                            onChange={(e) => saveFinancialLogShadowMode(e.target.checked)}
                        />
                        Shadow mode — limit <Link to="/financial" target="_blank" rel="noopener" style={{ color: '#0f8' }}>/financial</Link> to allowlisted managers
                    </label>
                    {form.financialLogShadowEnabled ? (
                        <div style={{ display: 'grid', gap: 8 }}>
                            <div>
                                <span className="mgr-field-label">SHADOW ALLOWLIST</span>
                                <input
                                    className="st-input"
                                    value={form.financialLogShadowAllowlist}
                                    placeholder="Manager names, comma-separated"
                                    onChange={(e) => setForm({ ...form, financialLogShadowAllowlist: e.target.value })}
                                />
                            </div>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <button type="button" className="st-btn" style={{ width: 'auto', padding: '6px 12px', fontSize: '0.75em' }} onClick={saveFinancialLogAllowlist}>
                                    SAVE ALLOWLIST
                                </button>
                                <button type="button" className="st-btn" style={{ width: 'auto', padding: '6px 12px', fontSize: '0.75em' }} onClick={clearFinancialLogAllowlist}>
                                    CLEAR ALLOWLIST
                                </button>
                            </div>
                            <p style={{ fontSize: '0.72em', color: '#8cf', margin: 0, textTransform: 'none' }}>
                                {form.financialLogShadowAllowlist.trim()
                                    ? 'Only listed managers see Financial Log. Others get no hub link and cannot open the portal.'
                                    : 'Allowlist is empty — the first manager to open /financial can claim access, or set names here.'}
                            </p>
                        </div>
                    ) : (
                        <p style={{ fontSize: '0.72em', color: '#8cf', margin: 0, textTransform: 'none' }}>
                            Shadow mode is off — all managers can open Financial Log from the Management Hub.
                        </p>
                    )}
                </div>
                <p style={{ gridColumn: '1/-1', fontSize: '0.72em', color: '#8cf', margin: 0, textTransform: 'none' }}>{csHint}</p>
            </div>

            <div className="mgr-section-title">ZONE NAMES &amp; OWNERS</div>
            <div className="mgr-form-grid-2 mgr-card">
                {['zone1', 'zone2', 'zone3', 'zone4'].map((z, i) => (
                    <div key={z}>
                        <span className="mgr-field-label">{`ZONE ${i + 1} NAME`}</span>
                        <input className="st-input" value={form.zoneNames[z]} onChange={(e) => setForm({ ...form, zoneNames: { ...form.zoneNames, [z]: e.target.value } })} />
                    </div>
                ))}
                {['zone1', 'zone2', 'zone3', 'zone4'].map((z, i) => (
                    <div key={`own-${z}`}>
                        <span className="mgr-field-label">{`ZONE ${i + 1} OWNER`}</span>
                        <select className="st-input" value={form.zoneOwners[z]} onChange={(e) => setForm({ ...form, zoneOwners: { ...form.zoneOwners, [z]: e.target.value } })}>
                            <option value="">— UNASSIGNED —</option>
                            {staffNames.map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                    </div>
                ))}
            </div>

            <div className="mgr-section-title">SECTION LABELS &amp; ZONE ASSIGNMENT</div>
            <p className="mgr-hint">Map sections (A1–A8, RFZ, FSFRZ) to zones and display labels on the TV / Home Base map.</p>
            <div className="section-grid mgr-card">
                {MAP_SECTIONS.map((id) => (
                    <div key={id} className="section-chip">
                        <div className="section-chip-id">{id.replace('map-', '').toUpperCase()}</div>
                        <input
                            className="st-input"
                            placeholder="Label"
                            style={{ margin: '0 0 4px', fontSize: '0.85em', padding: '4px 6px' }}
                            value={form.sectionLabels[id]?.label || ''}
                            onChange={(e) => setForm({
                                ...form,
                                sectionLabels: { ...form.sectionLabels, [id]: { ...form.sectionLabels[id], label: e.target.value } },
                            })}
                        />
                        <input
                            className="st-input"
                            placeholder="Sublabel"
                            style={{ margin: '0 0 4px', fontSize: '0.85em', padding: '4px 6px' }}
                            value={form.sectionLabels[id]?.sublabel || ''}
                            onChange={(e) => setForm({
                                ...form,
                                sectionLabels: { ...form.sectionLabels, [id]: { ...form.sectionLabels[id], sublabel: e.target.value } },
                            })}
                        />
                        <select
                            className="st-input"
                            style={{ margin: 0, fontSize: '0.85em' }}
                            value={form.sectionZones[id]}
                            onChange={(e) => setForm({ ...form, sectionZones: { ...form.sectionZones, [id]: e.target.value } })}
                        >
                            <option value="Zone 1">Zone 1</option>
                            <option value="Zone 2">Zone 2</option>
                            <option value="Zone 3">Zone 3</option>
                            <option value="Zone 4">Zone 4</option>
                        </select>
                    </div>
                ))}
            </div>

            <div className="mgr-section-title">FIFO AUDIT ASSIGNMENTS</div>
            <p className="mgr-hint">Shown on Home Base map and TV. Aisles: comma-separated.</p>
            <datalist id="fifo-staff-options">
                {staffNames.map((n) => <option key={n} value={n} />)}
            </datalist>
            <div className="mgr-card">
                {form.fifoRows.length ? form.fifoRows.map((row, idx) => (
                    <div key={idx} className="fifo-assign-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr auto', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                        <input
                            className="st-input fifo-staff"
                            list="fifo-staff-options"
                            placeholder="Staff name"
                            value={row.staff || ''}
                            style={{ margin: 0 }}
                            onChange={(e) => updateFifoRow(idx, { staff: e.target.value })}
                        />
                        <input
                            className="st-input fifo-aisles"
                            placeholder="Aisles (comma-separated)"
                            value={Array.isArray(row.aisles) ? row.aisles.join(', ') : (row.aislesRaw || '')}
                            style={{ margin: 0 }}
                            onChange={(e) => updateFifoRow(idx, { aislesRaw: e.target.value })}
                        />
                        <button type="button" className="st-btn" style={{ width: 'auto', padding: '4px 10px', borderColor: '#f33', color: '#f33' }} onClick={() => removeFifoRow(idx)}>DEL</button>
                    </div>
                )) : (
                    <div style={{ color: '#b0b0b0', fontSize: '0.85em' }}>No assignments yet — add rows below.</div>
                )}
            </div>
            <button type="button" className="st-btn subtle" style={{ width: 'auto', marginBottom: 20 }} onClick={addFifoRow}>➕ ADD ASSIGNMENT</button>

            <button type="button" className="st-btn" style={{ borderColor: 'var(--ok)', color: 'var(--ok)', maxWidth: 320 }} onClick={saveAll}>💾 SAVE STORE &amp; TV SETTINGS</button>

            <div className="mgr-section-title" style={{ marginTop: 24 }}>TV DASHBOARD PAIRING</div>
            <div className="mgr-card">
                <p className="mgr-hint">
                    Pair wall displays from Settings → Devices. The one-time fragment pairing link appears when a device token is issued.
                </p>
            </div>
        </>
    );
}
