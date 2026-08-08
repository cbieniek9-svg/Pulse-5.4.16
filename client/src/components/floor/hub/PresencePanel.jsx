import { useState } from 'react';
import { useSync } from '../../../providers/SyncProvider.jsx';
import { useFloorUi } from '../../shared/NoticeProvider.jsx';

export default function PresencePanel() {
    const { syncData } = useSync();
    const { actions, showNotice } = useFloorUi();
    const settings = syncData?.settings || {};
    const board = syncData?.manager_meta?.presence_board;
    const enabled = settings.Presence_Enabled === '1' || syncData?.manager_meta?.presence_enabled;
    const [checked, setChecked] = useState(!!enabled);
    const [mode, setMode] = useState(settings.Presence_Asset_Mode || board?.asset_mode || 'staff');
    const [beaconId, setBeaconId] = useState('');
    const [label, setLabel] = useState('');
    const [assetType, setAssetType] = useState('cart');

    const toggle = async (on) => {
        setChecked(on);
        try {
            await actions.presenceToggle(on);
        } catch (e) {
            showNotice(e.message, 'error');
            setChecked(!on);
        }
    };

    const setAssetMode = async (val) => {
        setMode(val);
        try {
            await actions.presenceAssetMode(val);
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const cs = board?.config_summary || {};
    const regInfo = board?.analytics?.registry || {};
    const carts = (board?.live_assets || []).filter((a) => a.asset_type === 'cart').slice(0, 12);

    return (
        <>
            <p style={{ margin: '0 0 8px', fontSize: '0.82em', color: '#c7d7ec', textTransform: 'none' }}>
                Software-ready BLE presence — FINISH headcount stays authoritative.
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85em', marginBottom: 8, cursor: 'pointer', textTransform: 'none' }}>
                <input type="checkbox" checked={checked} onChange={(e) => toggle(e.target.checked)} />
                Enable BLE presence ingest
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <label style={{ fontSize: '0.75em', color: '#8cf', textTransform: 'none' }}>Count at FINISH</label>
                <select className="st-input" style={{ width: 'auto', minWidth: 140, margin: 0, fontSize: '0.8em' }} value={mode} onChange={(e) => setAssetMode(e.target.value)}>
                    <option value="staff">Staff badges</option>
                    <option value="cart">Smart carts</option>
                    <option value="both">Carts + badges</option>
                </select>
            </div>
            {!checked ? (
                <div style={{ opacity: 0.7, fontSize: '0.78em', color: '#8cf' }}>Off — enable when gateways/carts are ready.</div>
            ) : (
                <>
                    <div style={{ fontSize: '0.78em', color: '#8cf', marginBottom: 10, lineHeight: 1.5 }}>
                        {cs.hub_count || 0} hub · {cs.aisle_count || 0} aisle · {cs.corner_count ?? cs.gateway_count ?? 0} corner/gw
                        · Registry: {regInfo.carts || 0} carts, {regInfo.badges || 0} badges
                        {board?.alerts?.offline_count ? <div style={{ color: '#f44' }}>{board.alerts.offline_count} offline</div> : null}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                        <button type="button" className="st-btn" style={{ width: 'auto', padding: '4px 10px', fontSize: '0.7em', borderColor: '#0cf', color: '#0cf' }} onClick={() => actions.presenceSeedDemo()}>SEED DEMO CARTS</button>
                        <button type="button" className="st-btn" style={{ width: 'auto', padding: '4px 10px', fontSize: '0.7em', borderColor: '#8cf', color: '#8cf' }} onClick={() => actions.presenceEnableAisle()}>ENABLE AISLE MAP</button>
                        <button type="button" className="st-btn subtle" style={{ width: 'auto', padding: '4px 10px', fontSize: '0.7em' }} onClick={() => actions.presenceDiscovery(true)}>ALLOW DISCOVERY</button>
                        <button type="button" className="st-btn" style={{ width: 'auto', padding: '4px 10px', fontSize: '0.7em', borderColor: '#fa0', color: '#fa0' }} onClick={() => actions.presenceRotateKey()}>ROTATE GATEWAY KEY</button>
                    </div>
                    <div style={{ fontSize: '0.75em', maxHeight: 200, overflow: 'auto', marginBottom: 10 }}>
                        {carts.length
                            ? (<><div style={{ color: '#69c', marginBottom: 4 }}>CARTS LIVE</div>{carts.map((a) => <div key={a.beacon_id}>{a.asset_label} · {a.zone_key}</div>)}</>)
                            : <div style={{ opacity: 0.6 }}>No carts in range — seed demo or register assets via API</div>}
                    </div>
                    <div style={{ marginTop: 8, padding: 8, border: '1px solid rgba(0,229,255,0.25)', borderRadius: 6, fontSize: '0.75em' }}>
                        <div style={{ color: '#69c', marginBottom: 6 }}>REGISTER BLE ASSET</div>
                        <input className="st-input" placeholder="cart-001 or badge UUID" style={{ marginBottom: 6, fontSize: '0.8em' }} value={beaconId} onChange={(e) => setBeaconId(e.target.value)} />
                        <input className="st-input" placeholder="Label (Cart 1 / Alex)" style={{ marginBottom: 6, fontSize: '0.8em' }} value={label} onChange={(e) => setLabel(e.target.value)} />
                        <select className="st-input" style={{ marginBottom: 6, fontSize: '0.8em' }} value={assetType} onChange={(e) => setAssetType(e.target.value)}>
                            <option value="cart">Cart</option>
                            <option value="badge">Staff badge</option>
                        </select>
                        <button
                            type="button"
                            className="st-btn"
                            style={{ width: 'auto', padding: '4px 12px', fontSize: '0.72em' }}
                            onClick={async () => {
                                try {
                                    await actions.presenceRegisterAsset({ beaconId, label, assetType });
                                    setBeaconId('');
                                    setLabel('');
                                    showNotice('Asset saved', 'success');
                                } catch (e) {
                                    showNotice(e.message, 'error');
                                }
                            }}
                        >
                            SAVE ASSET
                        </button>
                    </div>
                </>
            )}
        </>
    );
}
