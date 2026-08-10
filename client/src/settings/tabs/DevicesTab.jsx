import {
    useEffect, useRef, useState,
} from 'react';
import { useSettings } from '../context/SettingsContext.jsx';
import {
    authorizeDevice, createDevice, deleteDevice, fetchDeviceNetwork, issueDeviceToken,
    repurposeDevice, revokeDeviceToken, rotateDeviceToken,
} from '../lib/settingsApi.js';

const PURPOSE_OPTIONS = [
    { value: 'tv', label: 'TV display' },
    { value: 'cs_desk', label: 'Customer service desk' },
    { value: 'receiving', label: 'Receiving station' },
    { value: 'markdown', label: 'Markdown station' },
];

const BROWSER_PAIRING_PATHS = Object.freeze({
    tv: '/tv',
    cs_desk: '/cs',
    receiving: '/rec',
    markdown: '/markdown',
});

function purposeLabel(value) {
    return PURPOSE_OPTIONS.find((option) => option.value === value)?.label || 'Purpose not assigned';
}

function resolveHttpsBase(network) {
    const configured = String(network?.public_https_base_url || '').trim();
    if (!configured) return '';
    try {
        const parsed = new URL(configured);
        return parsed.protocol === 'https:' ? parsed.origin : '';
    } catch (_) {
        return '';
    }
}

function buildCredentialPresentation(result, network) {
    const token = result?.device_token;
    const purpose = result?.device?.device_purpose || '';
    const path = BROWSER_PAIRING_PATHS[purpose];
    const base = resolveHttpsBase(network);
    if (!token || !path) return null;
    if (!base) {
        return {
            purpose,
            value: '',
            message: 'HTTPS address unavailable; complete HTTPS setup before pairing this device.',
        };
    }
    return {
        purpose,
        value: `${base}${path}#deviceToken=${encodeURIComponent(token)}`,
        message: purpose === 'receiving' || purpose === 'markdown'
            ? 'This URL provisions an action credential only. Staff login and existing read authorization still apply.'
            : `Open this one-time ${purposeLabel(purpose)} pairing URL on the intended device.`,
    };
}

function OneTimeCredentialDialog({ credential, onClose }) {
    const [acknowledged, setAcknowledged] = useState(false);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        setAcknowledged(false);
        setCopied(false);
    }, [credential]);

    if (!credential) return null;
    const copy = async () => {
        if (!credential.value) return;
        try {
            await navigator.clipboard.writeText(credential.value);
            setCopied(true);
        } catch (_) {
            setCopied(false);
        }
    };

    return (
        <div
            role="presentation"
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 100000,
                display: 'grid',
                placeItems: 'center',
                padding: 18,
                background: 'rgba(2, 9, 18, 0.92)',
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="device-credential-title"
                className="mgr-card"
                style={{
                    width: 'min(620px, 100%)',
                    border: '2px solid #f90',
                    boxShadow: '0 24px 70px rgba(0,0,0,.65)',
                }}
            >
                <div id="device-credential-title" className="mgr-section-title" style={{ marginTop: 0 }}>
                    ONE-TIME DEVICE CREDENTIAL
                </div>
                <p style={{ textTransform: 'none', color: '#d8eaff' }}>{credential.message}</p>
                {credential.value ? (
                    <>
                        <input
                            className="st-input"
                            aria-label="One-time pairing URL"
                            readOnly
                            value={credential.value}
                            onFocus={(event) => event.target.select()}
                            style={{ textTransform: 'none', fontFamily: 'monospace' }}
                        />
                        <button type="button" className="st-btn" onClick={copy} style={{ marginTop: 10 }}>
                            COPY CREDENTIAL
                        </button>
                        <div role="status" aria-live="polite" style={{ minHeight: 22, marginTop: 6, color: '#0f8' }}>
                            {copied ? 'Credential copied to clipboard.' : ''}
                        </div>
                    </>
                ) : null}
                <label style={{ display: 'flex', gap: 9, alignItems: 'center', marginTop: 12, textTransform: 'none' }}>
                    <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(event) => setAcknowledged(event.target.checked)}
                    />
                    I have stored this credential or understand that HTTPS setup must be completed.
                </label>
                <button
                    type="button"
                    className="st-btn"
                    disabled={!acknowledged}
                    onClick={onClose}
                    style={{ marginTop: 14, borderColor: '#0f8', color: '#0f8' }}
                >
                    CLOSE
                </button>
            </div>
        </div>
    );
}

function PurposeSelect({
    value, onChange, id, label = 'Purpose', disabled = false,
}) {
    return (
        <label htmlFor={id} style={{ display: 'grid', gap: 5, flex: '1 1 210px' }}>
            <span className="mgr-hint" style={{ margin: 0 }}>{label}</span>
            <select
                id={id}
                className="st-input"
                required
                disabled={disabled}
                value={value}
                onChange={(event) => onChange(event.target.value)}
            >
                <option value="">Select purpose…</option>
                {PURPOSE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
        </label>
    );
}

function AddDeviceForm({ onCreate, busy }) {
    const [label, setLabel] = useState('');
    const [purpose, setPurpose] = useState('');

    const submit = async (event) => {
        event.preventDefault();
        if (!label.trim() || !purpose) return;
        const created = await onCreate(label.trim(), purpose);
        if (created) {
            setLabel('');
            setPurpose('');
        }
    };

    return (
        <form className="mgr-card" onSubmit={submit} style={{ marginBottom: 16 }}>
            <div className="mgr-status-title">ADD DEVICE</div>
            <div className="mgr-hint" style={{ marginTop: 5 }}>
                Create a station that did not appear through local discovery.
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end', marginTop: 12 }}>
                <label htmlFor="add-device-label" style={{ display: 'grid', gap: 5, flex: '2 1 260px' }}>
                    <span className="mgr-hint" style={{ margin: 0 }}>Device label</span>
                    <input
                        id="add-device-label"
                        className="st-input"
                        required
                        disabled={busy}
                        maxLength={120}
                        placeholder="e.g. Front customer service desk"
                        value={label}
                        onChange={(event) => setLabel(event.target.value)}
                    />
                </label>
                <PurposeSelect
                    id="add-device-purpose"
                    value={purpose}
                    onChange={setPurpose}
                    label="Required purpose"
                    disabled={busy}
                />
                <button type="submit" className="st-btn" disabled={busy || !label.trim() || !purpose}>
                    CREATE &amp; ISSUE TOKEN
                </button>
            </div>
        </form>
    );
}

function DeviceRow({
    dev, busy, onAuthorize, onIssueToken, onRepurpose, onRevokeToken, onDelete,
}) {
    const [label, setLabel] = useState('');
    const [purpose, setPurpose] = useState(dev.device_purpose || '');
    const pending = dev.status !== 'Authorized';
    const purposeChanged = !pending && purpose && purpose !== dev.device_purpose;

    useEffect(() => {
        setPurpose(dev.device_purpose || '');
    }, [dev.id, dev.device_purpose]);

    return (
        <div className="mgr-card" style={{ borderLeft: `4px solid ${dev.status === 'Authorized' ? '#0f8' : '#f90'}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ flex: 1 }}>
                    <strong style={{ color: '#fff' }}>{dev.label || 'Pending'}</strong>
                    <div style={{ fontSize: '0.78em', color: '#8cf', marginTop: 4 }}>
                        {dev.status}
                        {' · '}
                        {purposeLabel(dev.device_purpose)}
                        {' · '}
                        {dev.has_device_token ? 'Paired token' : 'Unpaired — token required'}
                        {dev.ip_address ? ` · Observed address ${dev.ip_address}` : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end', marginTop: 8 }}>
                        {pending ? (
                            <label htmlFor={`device-label-${dev.id}`} style={{ display: 'grid', gap: 5, flex: '2 1 240px' }}>
                                <span className="mgr-hint" style={{ margin: 0 }}>Required label</span>
                                <input
                                    id={`device-label-${dev.id}`}
                                    className="st-input"
                                    required
                                    disabled={busy}
                                    maxLength={120}
                                    placeholder="Name this device…"
                                    value={label}
                                    onChange={(event) => setLabel(event.target.value)}
                                />
                            </label>
                        ) : null}
                        <PurposeSelect
                            id={`device-purpose-${dev.id}`}
                            value={purpose}
                            onChange={setPurpose}
                            label={pending ? 'Required purpose' : 'Purpose'}
                            disabled={busy}
                        />
                    </div>
                </div>
                <div className="mgr-row-actions">
                    {pending ? (
                        <button
                            type="button"
                            className="st-btn"
                            disabled={busy || !label.trim() || !purpose}
                            onClick={() => onAuthorize(dev.id, label.trim(), purpose)}
                        >
                            AUTHORIZE &amp; ISSUE TOKEN
                        </button>
                    ) : null}
                    {dev.status === 'Authorized' ? (
                        <button type="button" className="st-btn" disabled={busy} onClick={() => onIssueToken(dev.id, dev.has_device_token)}>
                            {dev.has_device_token ? 'ROTATE TOKEN' : 'ISSUE TOKEN'}
                        </button>
                    ) : null}
                    {purposeChanged ? (
                        <button type="button" className="st-btn" disabled={busy} onClick={() => onRepurpose(dev.id, purpose)}>
                            REPURPOSE &amp; ROTATE
                        </button>
                    ) : null}
                    {dev.status === 'Authorized' && dev.has_device_token ? (
                        <button type="button" className="st-btn" disabled={busy} onClick={() => onRevokeToken(dev.id)}>REVOKE TOKEN</button>
                    ) : null}
                    <button type="button" className="st-btn" disabled={busy} style={{ borderColor: '#f33', color: '#f33' }} onClick={() => onDelete(dev.id)}>DELETE DEVICE</button>
                </div>
            </div>
        </div>
    );
}

export default function DevicesTab() {
    const {
        syncData, refresh, showNotice, appConfirm, token,
    } = useSettings();
    const [busy, setBusy] = useState(false);
    const [networkInfo, setNetworkInfo] = useState(null);
    const [credential, setCredential] = useState(null);
    const operationLock = useRef(false);
    const credentialResolver = useRef(null);
    const network = syncData && Object.prototype.hasOwnProperty.call(syncData, 'network')
        ? syncData.network
        : networkInfo;

    useEffect(() => {
        let active = true;
        fetchDeviceNetwork(token)
            .then((result) => {
                if (active) setNetworkInfo(result);
            })
            .catch(() => {
                if (active) setNetworkInfo(null);
            });
        return () => { active = false; };
    }, [token]);

    useEffect(() => () => {
        credentialResolver.current?.(false);
        credentialResolver.current = null;
    }, []);

    const refreshDevices = async () => {
        try {
            await refresh();
        } catch (e) {
            showNotice(
                `Device list refresh failed: ${e?.message || e}. The last action may have succeeded — refresh manually if the list looks stale.`,
                'warning',
            );
        }
    };

    const presentCredential = (result) => {
        const presentation = buildCredentialPresentation(result, network);
        if (!presentation) {
            return Promise.reject(new Error('Unable to build a pairing credential for this device.'));
        }
        if (credentialResolver.current) {
            return Promise.reject(new Error('Finish the current credential dialog first.'));
        }
        return new Promise((resolve) => {
            credentialResolver.current = resolve;
            setCredential(presentation);
        });
    };

    const closeCredential = () => {
        const resolver = credentialResolver.current;
        credentialResolver.current = null;
        setCredential(null);
        resolver?.(true);
    };

    const create = async (label, purpose) => {
        if (operationLock.current) return false;
        operationLock.current = true;
        setBusy(true);
        try {
            const result = await createDevice(label, purpose, token);
            await presentCredential(result);
            showNotice('Device created. One-time token generated.', 'success');
            return true;
        } catch (e) {
            showNotice(e.message, 'error');
            return false;
        } finally {
            await refreshDevices();
            operationLock.current = false;
            setBusy(false);
        }
    };

    const authorize = async (id, label, purpose) => {
        if (operationLock.current) return;
        operationLock.current = true;
        setBusy(true);
        try {
            const result = await authorizeDevice(id, label, purpose, token);
            await presentCredential(result);
            showNotice('Device authorized. Token pairing URL generated.', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        } finally {
            await refreshDevices();
            operationLock.current = false;
            setBusy(false);
        }
    };

    const issueToken = async (id, rotate = false) => {
        if (operationLock.current) return;
        operationLock.current = true;
        setBusy(true);
        try {
            if (!(await appConfirm('Issue a new token for this device? The old token will stop working.'))) return;
            const result = rotate
                ? await rotateDeviceToken(id, token)
                : await issueDeviceToken(id, token);
            await presentCredential(result);
            showNotice('Device token issued.', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        } finally {
            await refreshDevices();
            operationLock.current = false;
            setBusy(false);
        }
    };

    const repurpose = async (id, purpose) => {
        if (operationLock.current) return;
        operationLock.current = true;
        setBusy(true);
        try {
            if (!(await appConfirm('Change this device purpose and rotate its token? The old token will stop working immediately.'))) return;
            const result = await repurposeDevice(id, purpose, token);
            await presentCredential(result);
            showNotice('Device purpose changed and token rotated.', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        } finally {
            await refreshDevices();
            operationLock.current = false;
            setBusy(false);
        }
    };

    const revokeToken = async (id) => {
        if (operationLock.current) return;
        operationLock.current = true;
        setBusy(true);
        try {
            if (!(await appConfirm('Revoke only the token for this device?'))) return;
            await revokeDeviceToken(id, token);
            showNotice('Device token revoked.', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        } finally {
            await refreshDevices();
            operationLock.current = false;
            setBusy(false);
        }
    };

    const deleteDev = async (id) => {
        if (operationLock.current) return;
        operationLock.current = true;
        setBusy(true);
        try {
            if (!(await appConfirm('Delete this device and revoke its access?'))) return;
            await deleteDevice(id, token);
            showNotice('Device deleted.', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        } finally {
            await refreshDevices();
            operationLock.current = false;
            setBusy(false);
        }
    };

    const devices = syncData?.devices || [];

    return (
        <>
            <div className="mgr-section-title">TV &amp; DEVICE PAIRING</div>
            <p className="mgr-hint">
                Every device needs a manager-assigned purpose and token. TV and customer service support one-time browser pairing links.
            </p>
            <div className="mgr-card" style={{ marginBottom: 16 }}>
                Pairing links use a URL fragment and are shown once. Receiving and markdown credentials are shown as API/station tokens.
            </div>
            <AddDeviceForm onCreate={create} busy={busy} />
            <div id="settings-device-list">
                {devices.length ? devices.map((dev) => (
                    <DeviceRow
                        key={dev.id}
                        dev={dev}
                        busy={busy}
                        onAuthorize={authorize}
                        onIssueToken={issueToken}
                        onRepurpose={repurpose}
                        onRevokeToken={revokeToken}
                        onDelete={deleteDev}
                    />
                )) : (
                    <div className="mgr-card" style={{ color: '#b0b0b0' }}>
                        No pending or paired devices.
                    </div>
                )}
            </div>
            <OneTimeCredentialDialog credential={credential} onClose={closeCredential} />
        </>
    );
}
