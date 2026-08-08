import { useCallback, useEffect, useState } from 'react';
import { useSettings } from '../context/SettingsContext.jsx';
import StatusPill from '../components/StatusPill.jsx';
import { formatApiError } from '../../lib/api.js';
import { formatBytes, formatDateTime } from '../lib/settingsHelpers.js';
import {
    downloadLiveBackup, fetchMaintenanceHealth, runBackupVerification, secureThisStore,
} from '../lib/settingsApi.js';
import RestartRequiredBanner from '../../components/floor/RestartRequiredBanner.jsx';

function KvList({ rows }) {
    return (
        <dl className="mgr-kv">
            {rows.map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                    <dt>{k}</dt>
                    <dd>{v ?? 'n/a'}</dd>
                </div>
            ))}
        </dl>
    );
}

export default function MaintenanceTab() {
    const { syncData, showNotice, appConfirm, token, refresh } = useSettings();
    const [data, setData] = useState({
        health: null, readiness: null, network: null, release: null, audit: [], verify: null, loading: false,
    });

    const load = useCallback(async ({ silent = false } = {}) => {
        if (!token) return;
        setData((d) => ({ ...d, loading: true }));
        try {
            const result = await fetchMaintenanceHealth(token);
            setData((d) => ({
                ...d,
                ...result,
                network: result.network || syncData?.network || null,
                loading: false,
            }));
            if (!silent) showNotice('Maintenance health refreshed.', 'success');
        } catch (e) {
            setData((d) => ({ ...d, loading: false }));
            if (!silent) showNotice(e.message || 'Maintenance refresh failed.', 'error');
        }
    }, [token, syncData, showNotice]);

    useEffect(() => {
        load({ silent: true });
    }, [load]);

    const runVerify = async () => {
        if (!(await appConfirm('Run a backup restore drill against the latest generated backup?'))) return;
        setData((d) => ({ ...d, verify: { ok: null, stage: 'running', error: 'Backup drill running…' } }));
        try {
            const result = await runBackupVerification(token);
            setData((d) => ({ ...d, verify: result }));
            showNotice(result.ok ? 'Backup drill passed.' : 'Backup drill failed.', result.ok ? 'success' : 'error');
            await load({ silent: true });
        } catch (e) {
            const msg = formatApiError(e, e.message || 'Backup drill request failed.');
            setData((d) => ({ ...d, verify: { ok: false, stage: 'request', error: msg } }));
            showNotice(msg, 'error');
        }
    };

    const secureStore = async () => {
        if (!(await appConfirm(
            'Enforce token-only device access? The check will report authorized devices missing a token or purpose. Pair under Settings → Devices.',
        ))) return;
        try {
            const body = await secureThisStore(token);
            if (body.readiness) setData((d) => ({ ...d, readiness: body.readiness }));
            const incomplete = Number(body.device_security?.missing_token_or_purpose || 0);
            showNotice(
                body.message || 'Token-only device access enforced.',
                incomplete ? 'warning' : 'success',
            );
            await load({ silent: true });
        } catch (e) {
            showNotice(e.message || 'Secure store request failed.', 'error');
        }
    };

    const downloadBackup = async () => {
        if (!(await appConfirm('Download a copy of the live database?'))) return;
        try {
            const blob = await downloadLiveBackup(token);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `TGP_Backup_${new Date().toISOString().slice(0, 10)}.db`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            showNotice('Live database backup download started.', 'success');
            await load({ silent: true });
            await refresh();
        } catch (e) {
            showNotice(formatApiError(e, e.message || 'Backup download failed.'), 'error');
        }
    };

    const h = data.health;
    const b = h?.checks?.backups;
    const n = data.network || syncData?.network;
    const checked = h?.checked_at || data.readiness?.checked_at;

    return (
        <>
            <RestartRequiredBanner compact />
            <div className="mgr-section-title">MAINTENANCE &amp; READINESS</div>
            <p className="mgr-hint">Single-store PoC health view.</p>

            <div className="mgr-card">
                <div className="mgr-maint-actions">
                    <button type="button" className="st-btn" onClick={() => load()}>↻ REFRESH HEALTH</button>
                    <button type="button" className="st-btn" onClick={runVerify}>🧪 RUN BACKUP DRILL</button>
                    <button type="button" className="st-btn" onClick={downloadBackup}>⬇ DOWNLOAD LIVE DB</button>
                    <button type="button" className="st-btn" style={{ borderColor: '#f90', color: '#f90' }} onClick={secureStore}>🔒 SECURE THIS STORE</button>
                </div>
                <div className="mgr-hint" style={{ marginTop: 10, marginBottom: 0 }}>
                    Secure this store enforces token-only access. Pair devices under Settings → Devices with a purpose and token
                    (HTTPS pairing URL). On phones, accept the self-signed certificate warning once, then reopen the HTTPS link.
                    {data.loading ? ' Loading maintenance health…' : (checked ? ` Last checked: ${formatDateTime(checked)}` : '')}
                </div>
            </div>

            <div className="mgr-section-title">PRODUCTION READINESS</div>
            <div id="maintenance-readiness-list">
                {(data.readiness?.checks || []).length ? (data.readiness.checks).map((c) => (
                    <div key={c.id || c.label} className="mgr-status-row">
                        <div>
                            <div className="mgr-status-title">{c.label || c.id}</div>
                            <div className="mgr-status-summary">{c.summary || ''}</div>
                        </div>
                        <StatusPill status={c.status} />
                    </div>
                )) : (
                    <div className="mgr-card" style={{ color: '#b0b0b0' }}>Open this tab or click refresh to load readiness checks.</div>
                )}
            </div>

            <div className="mgr-maint-grid">
                <div className="mgr-card">
                    <div className="mgr-section-title" style={{ border: 'none', marginBottom: 10 }}>DATABASE</div>
                    {h ? (
                        <>
                            <div className="mgr-status-row">
                                <div>
                                    <div className="mgr-status-title">Overall</div>
                                    <div className="mgr-status-summary">{(h.errors || []).concat(h.warnings || []).join(' ') || 'No database errors or warnings.'}</div>
                                </div>
                                <StatusPill status={h.status} />
                            </div>
                            <KvList rows={[
                                ['Checked', formatDateTime(h.checked_at)],
                                ['Quick check', h.checks?.quick_check?.ok ? 'OK' : 'failed'],
                                ['Required tables', h.checks?.required_tables?.ok ? `${h.checks.required_tables.count || 0} present` : `Missing: ${(h.checks?.required_tables?.missing || []).join(', ')}`],
                                ['DB size', formatBytes(h.checks?.database_file?.size)],
                                ['Disk free', h.checks?.disk_space?.free_bytes != null ? formatBytes(h.checks.disk_space.free_bytes) : 'unavailable'],
                            ]}
                            />
                        </>
                    ) : (
                        <div className="mgr-hint">Not checked yet.</div>
                    )}
                </div>
                <div className="mgr-card">
                    <div className="mgr-section-title" style={{ border: 'none', marginBottom: 10 }}>BACKUPS</div>
                    {b ? (
                        <>
                            <KvList rows={[
                                ['Latest file', b.latest_file || 'none'],
                                ['Readable', b.latest_readable ? 'yes' : 'no'],
                                ['Verified', b.latest_verified ? 'yes' : 'no'],
                                ...(b.latest_verified
                                    ? []
                                    : [['Verify error', b.latest_verify_error || 'not verified']]),
                                ['Modified', formatDateTime(b.latest_modified_at)],
                                ['Age', b.latest_age_hours != null ? `${b.latest_age_hours} hours` : 'n/a'],
                                ['Size', formatBytes(b.latest_size)],
                                ['Generated backups', b.count ?? 0],
                            ]}
                            />
                            {data.verify ? (
                                <div style={{ marginTop: 12 }}>
                                    <div className="mgr-status-row">
                                        <div>
                                            <div className="mgr-status-title">Backup drill</div>
                                            <div className="mgr-status-summary">
                                                {data.verify.ok ? `Passed for ${data.verify.backup || 'latest backup'}` : `${data.verify.stage || 'failed'}: ${data.verify.error || 'failed'}`}
                                            </div>
                                        </div>
                                        <StatusPill status={data.verify.ok ? 'ok' : 'error'} />
                                    </div>
                                </div>
                            ) : null}
                        </>
                    ) : (
                        <div className="mgr-hint">Backup health not checked yet.</div>
                    )}
                </div>
                <div className="mgr-card">
                    <div className="mgr-section-title" style={{ border: 'none', marginBottom: 10 }}>LAN EXPOSURE</div>
                    {n ? (
                        <KvList rows={[
                            ['LAN clients', n.allow_lan_clients ? 'enabled' : 'disabled'],
                            ['Bind host', n.bind_host || 'n/a'],
                            ['Port', n.port || 'n/a'],
                            ['Base URL', n.public_base_url || window.location.origin],
                            ['LAN addresses', (n.lan_addresses || []).join(', ') || 'none detected'],
                            ['Warnings', (n.warnings || []).join(' ') || 'none'],
                        ]}
                        />
                    ) : (
                        <div className="mgr-hint">Network status unavailable.</div>
                    )}
                </div>
                <div className="mgr-card">
                    <div className="mgr-section-title" style={{ border: 'none', marginBottom: 10 }}>RELEASE</div>
                    {data.release ? (
                        <KvList rows={[
                            ['App version', data.release.appVersion || 'unknown'],
                            ['Build date', data.release.buildDate || 'unknown'],
                            ['Release track', data.release.releaseTrack || 'unknown'],
                            ['DB schema', data.release.databaseSchemaVersion != null ? `${data.release.databaseSchemaVersion}/${data.release.latestMigration}` : 'unknown'],
                            ['Migrations current', data.release.migrationsCurrent === null ? 'unknown' : (data.release.migrationsCurrent ? 'yes' : 'no')],
                            ['Patches', (data.release.patches || []).join(', ') || 'none listed'],
                        ]}
                        />
                    ) : (
                        <div className="mgr-hint">Release manifest not loaded yet.</div>
                    )}
                </div>
            </div>

            <div className="mgr-section-title">RECENT MANAGER ACTIONS</div>
            <div id="manager-audit-log-list">
                {(data.audit || []).length ? data.audit.map((e) => (
                    <div key={e.id || `${e.created_at}-${e.action}`} className="mgr-card mgr-audit-event">
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                            <strong style={{ color: '#fff' }}>{e.action || 'manager_action'}</strong>
                            <span style={{ color: '#8cf' }}>{formatDateTime(e.created_at)}</span>
                        </div>
                        <div style={{ marginTop: 6, textTransform: 'none', color: '#d8eaff' }}>{e.summary || ''}</div>
                        <div className="meta">
                            {e.actor_name || 'Manager'} · {e.target_type || 'system'}
                            {e.target_id ? ` · ${e.target_id}` : ''} · {e.ip_address || 'unknown IP'}
                        </div>
                    </div>
                )) : (
                    <div className="mgr-card" style={{ color: '#b0b0b0' }}>No manager audit events found yet.</div>
                )}
            </div>
        </>
    );
}
