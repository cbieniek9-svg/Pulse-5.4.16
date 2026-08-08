import { useCallback, useEffect, useRef, useState } from 'react';
import { filterLoginStaff, getSync } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';

const LAST_LOGIN_KEY = 'tgp_last_login';

function readLastLogin() {
    try {
        return String(localStorage.getItem(LAST_LOGIN_KEY) || localStorage.getItem('tgp_user') || '').trim();
    } catch (_) {
        return '';
    }
}

export default function AuthScreen() {
    const { login } = useAuth();
    const [staff, setStaff] = useState([]);
    const [appVersion, setAppVersion] = useState('');
    const [manualName, setManualName] = useState(false);
    const [name, setName] = useState('');
    const [pin, setPin] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const manualNameRef = useRef(null);

    const loadStaff = useCallback(async () => {
        try {
            const data = await getSync();
            if (data?.appVersion) setAppVersion(data.appVersion);

            if (data?.staff) {
                const baseStaff = filterLoginStaff(data);
                const sorted = [...baseStaff].sort((a, b) => String(a.name).localeCompare(String(b.name)));
                const options = sorted.map((s) => ({
                    name: s.name,
                    label: s.name,
                }));
                setStaff(options);

                // Managers / Store Managers are omitted from the public roster (5.4.11).
                // If the last successful login isn't in that list, open typed unlock with the name ready.
                const last = readLastLogin();
                if (last && !options.some((s) => s.name === last)) {
                    setManualName(true);
                    setName(last);
                }
            }
        } catch (e) {
            console.error('[LOGIN] Staff fetch failed:', e.message);
            setTimeout(loadStaff, 5000);
        }
    }, []);

    useEffect(() => {
        void loadStaff();
    }, [loadStaff]);

    useEffect(() => {
        if (manualName) manualNameRef.current?.focus();
    }, [manualName]);

    const handleClaim = async (e) => {
        e.preventDefault();
        if (!name || !pin) {
            setError('Name and PIN required');
            return;
        }
        setBusy(true);
        setError('');
        try {
            await login(name, pin);
        } catch (err) {
            setError(err.message || 'Authentication failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div id="auth-screen">
            <form className="auth-box" onSubmit={handleClaim}>
                <div className="auth-header">
                    <div className="auth-title">UPLINK AUTH</div>
                    <div className="auth-version">
                        {appVersion ? `VERSION ${appVersion}` : 'VERSION …'}
                    </div>
                </div>
                <p style={{ fontSize: '0.85em', color: '#88ccff', marginBottom: '20px' }}>
                    Claim this device for your shift.
                </p>

                {manualName ? (
                    <>
                        <label className="sr-only" htmlFor="auth-user-manual">Enter your name</label>
                        <input
                            id="auth-user-manual"
                            ref={manualNameRef}
                            className="st-input"
                            value={name}
                            onChange={(ev) => setName(ev.target.value)}
                            placeholder="YOUR NAME"
                            aria-label="Enter your name"
                            autoComplete="username"
                            style={{ textAlign: 'center', marginBottom: '15px' }}
                            required
                        />
                        <p style={{ fontSize: '0.75em', color: '#7a9bb8', margin: '-8px 0 12px', textTransform: 'none' }}>
                            Managers type their name here — not listed in the dropdown. Case does not matter (Chris = chris).
                        </p>
                    </>
                ) : (
                    <>
                        <label className="sr-only" htmlFor="auth-user">Select your name</label>
                        <select
                            id="auth-user"
                            className="st-input"
                            value={name}
                            onChange={(ev) => setName(ev.target.value)}
                            aria-label="Select your name"
                            style={{ textAlign: 'center', marginBottom: '15px' }}
                            required
                        >
                            <option value="" disabled>Select Your Name</option>
                            {staff.map((s) => (
                                <option key={s.name} value={s.name}>{s.label}</option>
                            ))}
                        </select>
                        <p style={{ fontSize: '0.75em', color: '#7a9bb8', margin: '-8px 0 12px', textTransform: 'none' }}>
                            Manager login: use Enter name manually (managers are not listed).
                        </p>
                    </>
                )}
                <button
                    type="button"
                    className="st-btn"
                    onClick={() => {
                        setManualName((value) => {
                            const next = !value;
                            if (next) {
                                const last = readLastLogin();
                                setName(last || '');
                            } else {
                                setName('');
                            }
                            return next;
                        });
                    }}
                    style={{ marginBottom: '15px' }}
                >
                    {manualName ? 'Choose from staff list' : 'Enter name manually'}
                </button>

                <label className="sr-only" htmlFor="auth-pin">Personal PIN</label>
                <input
                    type="password"
                    id="auth-pin"
                    className="st-input"
                    value={pin}
                    onChange={(ev) => setPin(ev.target.value)}
                    placeholder="PERSONAL PIN"
                    aria-label="Personal PIN"
                    autoComplete="current-password"
                    style={{ textAlign: 'center', marginBottom: '12px', fontSize: '1.2em', letterSpacing: '10px' }}
                    required
                />

                {error ? (
                    <p role="alert" style={{ color: '#f66', fontSize: '0.85em', marginBottom: '12px', textTransform: 'none' }}>{error}</p>
                ) : null}

                <button type="submit" className="st-btn" disabled={busy}>
                    {busy ? 'VERIFYING…' : 'UNLOCK UPLINK'}
                </button>
            </form>
        </div>
    );
}
