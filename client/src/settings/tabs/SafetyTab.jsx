import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSettings } from '../context/SettingsContext.jsx';
import {
    clearSafetyFocus, importSafetyBlurbs, postSafetyFocus, saveSafetyBlurb,
} from '../lib/settingsApi.js';

function BlurbRow({ blurb, onPostToday, onSave, onToggle }) {
    const [message, setMessage] = useState(blurb.message || '');
    const active = Number(blurb.active) === 1;

    return (
        <div className="mgr-card" data-safety-id={blurb.id} style={{ borderLeft: `4px solid ${active ? '#0f8' : '#666'}` }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <textarea
                    className="st-input"
                    rows={2}
                    style={{ flex: 1, minWidth: 280, textTransform: 'none' }}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" className="st-btn" style={{ width: 'auto', padding: '7px 12px' }} onClick={() => onPostToday(blurb.id)}>POST TODAY</button>
                    <button type="button" className="st-btn subtle" style={{ width: 'auto', padding: '7px 12px' }} onClick={() => onSave(blurb.id, message)}>SAVE</button>
                    <button type="button" className="st-btn subtle" style={{ width: 'auto', padding: '7px 12px' }} onClick={() => onToggle(blurb.id, message, active ? 0 : 1)}>
                        {active ? 'DISABLE' : 'ENABLE'}
                    </button>
                </div>
            </div>
            <div style={{ fontSize: '0.7rem', color: '#789', marginTop: 8, textTransform: 'none' }}>
                #{blurb.id} · {active ? 'active' : 'inactive'}
                {blurb.last_used_date ? ` · last used ${blurb.last_used_date}` : ''}
            </div>
        </div>
    );
}

export default function SafetyTab() {
    const { syncData, refresh, showNotice, appConfirm, token } = useSettings();
    const [importText, setImportText] = useState('');

    const focus = syncData?.daily_safety_focus || null;
    const blurbs = syncData?.safety_blurbs || [];

    const doImport = async () => {
        const text = importText.trim();
        if (!text) {
            showNotice('Paste one safety blurb per line first.', 'error');
            return;
        }
        try {
            const res = await importSafetyBlurbs(text, token);
            setImportText('');
            showNotice(`Imported ${res.added_count || 0} safety blurb(s).`, 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message || 'Import failed.', 'error');
        }
    };

    const pickNext = async () => {
        try {
            await postSafetyFocus({}, token);
            showNotice('Next safety focus selected for today.', 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message || 'Could not pick safety focus.', 'error');
        }
    };

    const clearFocus = async () => {
        if (!(await appConfirm('Clear today\'s safety focus from the TV and Reports?'))) return;
        try {
            await clearSafetyFocus(token);
            showNotice('Today\'s safety focus cleared.', 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message || 'Could not clear safety focus.', 'error');
        }
    };

    const postToday = async (id) => {
        try {
            await postSafetyFocus({ blurb_id: id }, token);
            showNotice('Safety focus posted for today.', 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message || 'Could not post safety focus.', 'error');
        }
    };

    const saveBlurb = async (id, message) => {
        const msg = message.trim();
        if (!msg) {
            showNotice('Safety blurb cannot be blank.', 'error');
            return;
        }
        try {
            await saveSafetyBlurb({ id, message: msg }, token);
            showNotice('Safety blurb saved.', 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message || 'Could not save safety blurb.', 'error');
        }
    };

    const toggleBlurb = async (id, message, active) => {
        try {
            await saveSafetyBlurb({ id, message: message.trim(), active }, token);
            showNotice(active ? 'Safety blurb enabled.' : 'Safety blurb disabled.', 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message || 'Could not update safety blurb.', 'error');
        }
    };

    return (
        <>
            <div className="mgr-section-title">DAILY SAFETY BLURBS</div>
            <p className="mgr-hint">One short, approved safety reminder is selected per store day and stays fixed on the TV and Reports for that date.</p>

            <div className="mgr-card">
                <div className="mgr-section-title" style={{ border: 'none', marginBottom: 10 }}>TODAY&apos;S SAFETY FOCUS</div>
                <div style={{ fontSize: '1rem', color: '#fff', textTransform: 'none', lineHeight: 1.4, marginBottom: 12 }}>
                    {focus?.message ? (
                        <>
                            <div style={{ color: '#fa0', fontSize: '0.72rem', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 6 }}>
                                {focus.source === 'manual' ? 'Manager-set focus' : 'Daily rotation'}
                            </div>
                            <div>{focus.message}</div>
                            <div style={{ fontSize: '0.72rem', color: '#8cf', marginTop: 8, textTransform: 'none' }}>
                                {focus.store_date || syncData?.storeDate || ''} · {focus.selected_by || 'AUTO'}
                            </div>
                        </>
                    ) : (
                        <span style={{ color: '#b0b0b0' }}>No safety focus selected for today yet.</span>
                    )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" className="st-btn" style={{ width: 'auto', padding: '8px 16px' }} onClick={pickNext}>🔁 PICK NEXT FOR TODAY</button>
                    <button type="button" className="st-btn subtle" style={{ width: 'auto', padding: '8px 16px' }} onClick={clearFocus}>CLEAR TODAY</button>
                </div>
            </div>

            <div className="mgr-card">
                <div className="mgr-section-title" style={{ border: 'none', marginBottom: 10 }}>IMPORT BLURBS</div>
                <p className="mgr-hint" style={{ marginTop: -6 }}>Paste one short safety blurb per line.</p>
                <textarea
                    className="st-input"
                    rows={5}
                    style={{ width: '100%', minHeight: 110, textTransform: 'none' }}
                    placeholder="Safe cutting: cut away from your body..."
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                />
                <button type="button" className="st-btn" style={{ width: 'auto', padding: '8px 16px', marginTop: 10 }} onClick={doImport}>➕ IMPORT BLURBS</button>
            </div>

            <div className="mgr-section-title">BLURB ROTATION LIST</div>
            <p className="mgr-hint">Inactive blurbs stay saved but will not auto-rotate.</p>
            <div id="safety-blurb-list">
                {blurbs.length ? blurbs.map((b) => (
                    <BlurbRow
                        key={b.id}
                        blurb={b}
                        onPostToday={postToday}
                        onSave={saveBlurb}
                        onToggle={toggleBlurb}
                    />
                )) : (
                    <div className="mgr-card" style={{ color: '#b0b0b0' }}>No safety blurbs loaded yet.</div>
                )}
            </div>

            <div className="mgr-card" style={{ marginTop: 16, borderLeft: '4px solid #9c0' }}>
                <div className="mgr-section-title" style={{ border: 'none', marginBottom: 8 }}>MONTHLY SAFETY INSPECTIONS</div>
                <p className="mgr-hint">
                    Formal committee walk-throughs live on <Link to="/safe" style={{ color: '#9c0' }}>/safe</Link>.
                    Grant <strong>Safe</strong> under Staff → Access, or use a Manager role.
                </p>
            </div>
        </>
    );
}
