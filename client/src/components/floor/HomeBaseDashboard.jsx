import { memo, useMemo } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';
import {
    computeMapSectionStyle, colorForZone,
} from '../../lib/zoneMapColors.js';
import {
    isHeatMapZoneCold, normalizeMapZoneKey, resolveZoneMapping,
} from '../../lib/floorUtils.js';

const MAP_TILES = [
    { id: 'map-cmd', label: 'ZONE 4: TOBACCO / WRAP AROUND', sub: '', gridColumn: 'span 4', zoneKey: 'Zone 4' },
    { id: 'map-a1', label: 'A1', sub: 'POP' },
    { id: 'map-a3', label: 'A3', sub: 'HBA' },
    { id: 'map-a4', label: 'A4', sub: 'BAKE' },
    { id: 'map-a7', label: 'A7', sub: 'FS PAPER' },
    { id: 'map-a2', label: 'A2', sub: 'SNACK' },
    { id: 'map-a5', label: 'A5', sub: 'COFFEE', isA5: true },
    { id: 'map-rfz', label: 'RFZ', sub: 'RETAIL' },
    { id: 'map-a8', label: 'A8', sub: 'PKGS' },
    { id: 'map-a6', label: 'A6', sub: 'ETH/PET' },
    { id: 'map-fsfrz', label: 'FS FRZ', sub: 'MEAT' },
];

function HomeBaseMapInner() {
    const { syncData } = useSync();
    const settings = syncData?.settings || {};
    const tasks = syncData?.tasks || [];
    const zoneHeatMap = syncData?.zoneHeatMap || {};
    const threshold = 4 * 60 * 60 * 1000;
    const now = Date.now();

    const zones = useMemo(() => resolveZoneMapping(settings), [settings]);
    const sectionToZone = useMemo(() => {
        const out = {};
        Object.entries(zones).forEach(([zoneName, ids]) => {
            (ids || []).forEach((id) => { out[id] = normalizeMapZoneKey(zoneName); });
        });
        return out;
    }, [zones]);

    let owners = {};
    try { owners = JSON.parse(settings.Zone_Ownership || '{}'); } catch (_) { /* ignore */ }

    const fifoRows = useMemo(() => {
        try {
            return JSON.parse(settings.FIFO_Aisle_Assignments || '[]');
        } catch (_) {
            return [];
        }
    }, [settings.FIFO_Aisle_Assignments]);

    const getTileStyle = (tileId) => {
        const zoneName = sectionToZone[tileId];
        const lastAudit = zoneName ? zoneHeatMap[zoneName] : null;
        const isCold = isHeatMapZoneCold(lastAudit, now, threshold);
        return computeMapSectionStyle(tileId, zoneName, isCold, tasks);
    };

    return (
        <div className="col-left" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid #1f3b5c', borderRadius: 8, padding: 15 }}>
            <div style={{ color: '#0f8', fontSize: '0.8em', fontWeight: 'bold', marginBottom: 15, borderBottom: '1px solid #1f3b5c', paddingBottom: 5 }}>TOP-DOWN STORE MAP</div>

            {fifoRows.length ? (
                <div style={{ marginBottom: 12 }}>
                    <div style={{ color: '#0f8', fontWeight: 'bold', marginBottom: 6, letterSpacing: 1 }}>FIFO AUDIT ASSIGNMENTS</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: '4px 10px' }}>
                        {[...fifoRows].sort((a, b) => String(a.staff).localeCompare(String(b.staff))).map((r) => (
                            <div key={r.staff} style={{ background: 'rgba(255,255,255,0.04)', padding: '4px 6px', borderRadius: 3 }}>
                                <strong style={{ color: '#fff' }}>{r.staff}</strong>
                                <br />
                                <small style={{ color: '#8cf' }}>{(r.aisles || []).join(' · ')}</small>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}

            <div className="homebase-map-shell">
                <div className="homebase-map-grid">
                    {MAP_TILES.map((tile) => {
                        const style = getTileStyle(tile.id);
                        return (
                            <div
                                key={tile.id}
                                id={tile.id}
                                className={style.priorityClass || undefined}
                                style={{
                                    gridColumn: tile.gridColumn,
                                    background: style.background,
                                    border: `1px solid ${style.borderColor}`,
                                    borderRadius: 3,
                                    padding: 10,
                                    display: 'flex',
                                    flexDirection: 'column',
                                    justifyContent: 'center',
                                    opacity: style.opacity,
                                    boxShadow: style.boxShadow,
                                    transition: 'background 0.5s',
                                }}
                            >
                                <strong style={{ color: style.labelColor }}>{tile.label}</strong>
                                {tile.sub ? <><br /><small style={{ color: '#aaa' }}>{tile.sub}</small></> : null}
                            </div>
                        );
                    })}
                    <div />
                    <div />
                </div>
                <div className="homebase-map-legend">
                    {Object.entries(owners).map(([z, name]) => {
                        const key = normalizeMapZoneKey(z);
                        const color = colorForZone(key);
                        return (
                            <span key={z}>
                                <span style={{ color }}>■</span>
                                {' '}
                                {key === 'Zone 4' ? 'Z4' : key}: {name}
                            </span>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

function HomeBaseDashboardInner({ onClose }) {
    return (
        <div style={{ marginBottom: 20 }}>
            <div className="header-bar" style={{ background: 'linear-gradient(90deg, #1f3b5c, #000)', borderColor: '#0f8' }}>
                <div className="header-title" style={{ color: '#0f8' }}>🏠 HOME BASE VISUAL MAP & 5S REFERENCE</div>
                <button type="button" className="st-btn" style={{ width: 'auto', padding: '5px 10px', fontSize: '0.7em' }} onClick={onClose}>CLOSE MAP</button>
            </div>
            <div className="split-layout" style={{ marginTop: 15, gap: 15 }}>
                <HomeBaseMapInner />
                <div className="col-right" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid #1f3b5c', borderRadius: 8, padding: 15 }}>
                    <div style={{ color: '#0f8', fontSize: '0.8em', fontWeight: 'bold', marginBottom: 15, borderBottom: '1px solid #1f3b5c', paddingBottom: 5 }}>5S RECOVERY PROTOCOL</div>
                    {[
                        ['SORT', 'CLEAR CARDBOARD, DEAD STOCK, PALLETS'],
                        ['SET IN ORDER', 'SQUARE BOXES, FLUSH FRONT, ALIGN TAGS'],
                        ['SHINE', 'WIPE DOORS, CLEAR DECKS, SWEEP AISLE'],
                        ['STANDARDIZE', 'CHECK AGAINST CORE 4 STANDARDS'],
                        ['SUSTAIN', 'AUDIT AGAIN IN 2 HOURS'],
                    ].map(([title, sub], i) => (
                        <div key={title} style={{ background: 'rgba(255,255,255,0.03)', padding: 8, borderRadius: 4, display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                            <strong style={{ color: '#0f8', fontSize: '1.1em' }}>{i + 1}</strong>
                            <div>
                                <strong style={{ color: '#fff', fontSize: '0.8em' }}>{title}</strong>
                                <br />
                                <small style={{ color: '#aaa', fontSize: '0.8em' }}>{sub}</small>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

export default memo(HomeBaseDashboardInner);
