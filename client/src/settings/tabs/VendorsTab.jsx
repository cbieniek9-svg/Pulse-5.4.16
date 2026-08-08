import { useState } from 'react';
import { useSettings } from '../context/SettingsContext.jsx';
import { RHYTHM_DAYS, genId, sortVendorRows } from '../lib/settingsHelpers.js';

const VENDOR_DAYS = RHYTHM_DAYS.filter((d) => d !== 'Everyday');

export default function VendorsTab() {
    const { syncData, action, refresh, showNotice, appConfirm } = useSettings();
    const [day, setDay] = useState('Monday');
    const [vendor, setVendor] = useState('');

    const rows = sortVendorRows(syncData?.vendor_schedule);

    const addVendor = async () => {
        const name = vendor.trim();
        if (!name) {
            showNotice('Vendor name is required.', 'error');
            return;
        }
        try {
            await action('vendor_schedule', 'insert', {
                id: genId('V'),
                day,
                vendor: name,
            });
            setVendor('');
            showNotice('Vendor day added.', 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const deleteVendor = async (id) => {
        if (!(await appConfirm('Remove this vendor from the schedule?'))) return;
        try {
            await action('vendor_schedule', 'delete', {}, 'id', id);
            showNotice('Vendor schedule entry removed.', 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    return (
        <>
            <div className="mgr-section-title">VENDOR DELIVERY SCHEDULE</div>
            <p className="mgr-hint">Expected vendors by weekday. These become pending deliveries when the daily rhythm loads.</p>
            <div className="mgr-card">
                <div className="mgr-form-grid">
                    <div>
                        <span className="mgr-field-label">DAY</span>
                        <select className="st-input" value={day} onChange={(e) => setDay(e.target.value)}>
                            {VENDOR_DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                    </div>
                    <div>
                        <span className="mgr-field-label">VENDOR NAME</span>
                        <input className="st-input" placeholder="e.g. Coca-Cola" value={vendor} onChange={(e) => setVendor(e.target.value)} />
                    </div>
                </div>
                <button type="button" className="st-btn" style={{ width: 'auto', padding: '8px 20px', borderColor: '#f90', color: '#f90' }} onClick={addVendor}>➕ ADD VENDOR DAY</button>
            </div>
            <div className="mgr-table-wrap">
                <table className="mgr-table">
                    <thead><tr><th>DAY</th><th>VENDOR</th><th /></tr></thead>
                    <tbody>
                        {rows.length ? rows.map((v) => (
                            <tr key={v.id}>
                                <td>{v.day}</td>
                                <td>{v.vendor}</td>
                                <td className="mgr-row-actions">
                                    <button type="button" className="st-btn" style={{ borderColor: '#f33', color: '#f33' }} onClick={() => deleteVendor(v.id)}>DEL</button>
                                </td>
                            </tr>
                        )) : (
                            <tr>
                                <td colSpan={3} style={{ color: '#b0b0b0', textAlign: 'center', padding: 24 }}>
                                    No vendor schedule entries yet.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </>
    );
}
