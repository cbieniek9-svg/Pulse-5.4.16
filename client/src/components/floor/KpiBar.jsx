import { memo } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';

function KpiBarInner() {
    const { syncData } = useSync();
    const k = syncData?.kpis || {};
    const counts = syncData?.counts || {};

    const pph = k.shift_active && k.shift_pph != null
        ? k.shift_pph
        : (k.shift_pph_final != null ? k.shift_pph_final : '—');
    const std = k.shift_standard_pph || 55;
    const pphLow = k.shift_active && k.shift_pph != null && k.shift_pph < std;
    const staffValue = k.shift_active && k.order_staff != null ? k.order_staff : (k.staff ?? counts.staff ?? 1);
    const staffLabel = k.shift_active ? 'STAFF ON ORDER' : 'STAFF';
    const pphLabel = k.shift_active ? 'ACTUAL PPH' : 'PPH';

    return (
        <div className="kpi-container">
            <div className="kpi-box">
                <div className="kpi-label">GROCERY</div>
                <div className="kpi-value">
                    {k.g ?? counts.grocery ?? 0} <small>{k.g_hrs}H</small>
                </div>
            </div>
            <div className="kpi-box">
                <div className="kpi-label">FREEZER</div>
                <div className="kpi-value">
                    {k.f ?? counts.frozen ?? 0} <small>{k.f_hrs}H</small>
                </div>
            </div>
            <div className="kpi-box">
                <div className="kpi-label">HARDWARE</div>
                <div className="kpi-value">
                    {k.h ?? counts.hardware ?? 0} <small>({k.pieces_on_order ?? 0} ORD)</small>
                </div>
            </div>
            <div className="kpi-box">
                <div className="kpi-label">{staffLabel}</div>
                <div className="kpi-value">{staffValue}</div>
            </div>
            <div
                className="kpi-box"
                style={{
                    background: pphLow ? 'rgba(42, 26, 10, 0.6)' : 'rgba(11, 26, 46, 0.6)',
                    borderRightColor: pphLow ? '#f90' : '#00e5ff',
                }}
            >
                <div className="kpi-label">{pphLabel}</div>
                <div
                    className="kpi-value"
                    style={{
                        color: pphLow ? '#f90' : (k.shift_active && k.shift_pph != null ? '#0f8' : undefined),
                    }}
                >
                    {pph}
                </div>
            </div>
            <div className="kpi-box" style={{ background: 'rgba(0,0,0,0.4)' }}>
                <div className="kpi-label">EST HRS/PERSON</div>
                <div className="kpi-value" style={{ color: '#f90' }}>{k.hrs_per_person ?? '0.0'}H</div>
            </div>
        </div>
    );
}

const KpiBar = memo(KpiBarInner);
export default KpiBar;
