import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.jsx';
import { getSync, filterLoginStaff } from '../../lib/api.js';
import { isManagerRole } from '../../lib/roles.js';
import { getSafeLoginOptions } from '../../safe/safeApi.js';
import { canUseSafe } from '../../safe/safeUtils.js';

export default function PortalAuth({
    title,
    subtitle,
    buttonLabel = 'UNLOCK',
    backTo = '/',
    backLabel = '← Back to TGP Center Store',
    requireManager = false,
    requireSafeAccess = false,
    onAuthenticated,
    verifyingFallback = null,
    children,
}) {
    const { login, logout, isAuthenticated } = useAuth();
    const [staff, setStaff] = useState([]);
    const [manualName, setManualName] = useState(Boolean(requireManager));
    const [name, setName] = useState('');
    const [pin, setPin] = useState('');
    const [status, setStatus] = useState('');
    const [loading, setLoading] = useState(false);
    const manualNameRef = useRef(null);
    const needsGate = requireManager || requireSafeAccess;
    const [accessOk, setAccessOk] = useState(!needsGate);
    const [verifying, setVerifying] = useState(() => {
        if (!needsGate) return false;
        try { return Boolean(sessionStorage.getItem('tgp_token')); } catch (_) { return false; }
    });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                if (requireSafeAccess) {
                    const data = await getSafeLoginOptions();
                    if (cancelled) return;
                    setStaff(Array.isArray(data.staff) ? data.staff : []);
                } else {
                    const sync = await getSync();
                    if (cancelled) return;
                    const options = filterLoginStaff(sync);
                    setStaff(options);
                    // Managers are omitted from the public roster — reopen typed unlock with last name.
                    if (!requireManager) {
                        let last = '';
                        try { last = String(localStorage.getItem('tgp_last_login') || '').trim(); } catch (_) { /* ignore */ }
                        if (last && !options.some((s) => s.name === last)) {
                            setManualName(true);
                            setName(last);
                        }
                    }
                }
            } catch (e) {
                if (!cancelled) setStatus(e.message || 'Could not load staff list.');
            }
        })();
        return () => { cancelled = true; };
    }, [requireSafeAccess]);

    useEffect(() => {
        if (manualName) manualNameRef.current?.focus();
    }, [manualName]);

    const verifyAccess = async (userName, token) => {
        if (requireSafeAccess) {
            const sync = await getSync(token || '');
            const me = sync?.staff?.find((s) => s.name === userName);
            const ok = canUseSafe(me?.role, me?.permissions);
            if (!ok) {
                setAccessOk(false);
                setStatus('Need Manager role or Safe permission (Settings → Staff → check Safe, then GRANT mobile login).');
                logout();
                return false;
            }
            setAccessOk(true);
            return true;
        }
        if (requireManager) {
            const sync = await getSync(token || '');
            const role = sync?.staff?.find((s) => s.name === userName)?.role;
            const ok = isManagerRole(role);
            if (!ok) {
                setAccessOk(false);
                setStatus('Manager role required.');
                logout();
                return false;
            }
            setAccessOk(true);
            return true;
        }
        setAccessOk(true);
        return true;
    };

    useEffect(() => {
        if (!isAuthenticated) {
            setAccessOk(!needsGate);
            setVerifying(false);
            return;
        }
        if (!needsGate) {
            setAccessOk(true);
            setVerifying(false);
            return;
        }
        let cancelled = false;
        setAccessOk(false);
        setVerifying(true);
        (async () => {
            try {
                const userName = localStorage.getItem('tgp_user') || '';
                const token = sessionStorage.getItem('tgp_token') || '';
                const ok = await verifyAccess(userName, token);
                if (cancelled) return;
                if (!ok) setStatus((s) => s || 'Access denied.');
            } catch (e) {
                if (!cancelled) {
                    setAccessOk(false);
                    setStatus(e.message || 'Could not verify access.');
                }
            } finally {
                if (!cancelled) setVerifying(false);
            }
        })();
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthenticated, requireManager, requireSafeAccess]);

    useEffect(() => {
        if (isAuthenticated && accessOk && typeof onAuthenticated === 'function') {
            onAuthenticated();
        }
    }, [isAuthenticated, accessOk, onAuthenticated]);

    // Never mount protected children until accessOk — verifying must not flash the app.
    if (isAuthenticated && accessOk) {
        return children;
    }
    if (isAuthenticated && verifying) {
        if (verifyingFallback) return verifyingFallback;
        return (
            <div
                id="auth-screen"
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: '100vh',
                    background: 'radial-gradient(circle at center, #0b1a2e 0%, #000 100%)',
                    color: '#88ccff',
                    fontSize: '0.95rem',
                }}
            >
                Verifying access…
            </div>
        );
    }

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!name || !pin) {
            setStatus('Name and PIN required.');
            return;
        }
        setLoading(true);
        setStatus('');
        try {
            if (needsGate) {
                setAccessOk(false);
                setVerifying(true);
            }
            await login(name, pin);
            if (needsGate) {
                const token = sessionStorage.getItem('tgp_token') || '';
                await verifyAccess(name, token);
            } else {
                setAccessOk(true);
            }
        } catch (err) {
            setAccessOk(false);
            setStatus(err.message || 'Login failed.');
        } finally {
            setVerifying(false);
            setLoading(false);
        }
    };

    const safeTheme = requireSafeAccess;

    return (
        <div
            id="auth-screen"
            className={safeTheme ? 'safe-portal safe-auth-screen' : undefined}
            style={safeTheme ? undefined : {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: '100vh',
                background: 'radial-gradient(circle at center, #0b1a2e 0%, #000 100%)',
            }}
        >
            <form
                className={safeTheme ? 'auth-box' : undefined}
                onSubmit={handleSubmit}
                style={safeTheme ? undefined : {
                    background: 'rgba(11,26,46,0.9)',
                    border: '1px solid #00e5ff',
                    borderRadius: 10,
                    padding: 36,
                    width: '90%',
                    maxWidth: 340,
                    textAlign: 'center',
                }}
            >
                <div
                    className={safeTheme ? 'title' : 'auth-title'}
                    style={safeTheme ? { color: '#9c0', marginBottom: 20 } : {
                        fontSize: '1.2rem',
                        letterSpacing: '4px',
                        color: '#eef5ff',
                        marginBottom: 24,
                    }}
                >
                    {title}
                </div>
                {subtitle ? (
                    <p className={safeTheme ? 'hint' : undefined} style={safeTheme ? { marginBottom: 16 } : { fontSize: '0.85em', color: '#88ccff', marginBottom: 20, textTransform: 'none' }}>
                        {subtitle}
                    </p>
                ) : null}
                {manualName ? (
                    <>
                        <label className="sr-only" htmlFor="portal-auth-user-manual">Enter your name</label>
                        <input
                            id="portal-auth-user-manual"
                            ref={manualNameRef}
                            className={safeTheme ? 'input' : 'st-input'}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="YOUR NAME"
                            aria-label="Enter your name"
                            autoComplete="username"
                            style={safeTheme ? undefined : { textAlign: 'center', marginBottom: 12, width: '100%' }}
                        />
                    </>
                ) : (
                    <>
                        <label className="sr-only" htmlFor="portal-auth-user">Select your name</label>
                        <select
                            id="portal-auth-user"
                            className={safeTheme ? 'input' : 'st-input'}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            aria-label="Select your name"
                            style={safeTheme ? undefined : { textAlign: 'center', marginBottom: 12, width: '100%' }}
                        >
                            <option value="" disabled>Select Your Name</option>
                            {staff.length ? staff.map((s) => (
                                <option key={s.name} value={s.name}>{s.name}</option>
                            )) : (
                                <option value="" disabled>
                                    {requireSafeAccess
                                        ? 'No eligible staff — grant mobile login + Manager or Safe'
                                        : 'No staff available'}
                                </option>
                            )}
                        </select>
                    </>
                )}
                <button
                    type="button"
                    className={safeTheme ? 'btn' : 'st-btn'}
                    onClick={() => {
                        setManualName((value) => {
                            const next = !value;
                            if (next) {
                                let last = '';
                                try { last = String(localStorage.getItem('tgp_last_login') || '').trim(); } catch (_) { /* ignore */ }
                                setName(last || '');
                            } else {
                                setName('');
                            }
                            return next;
                        });
                    }}
                    style={safeTheme ? { width: '100%', marginBottom: 12 } : { width: '100%', marginBottom: 12 }}
                >
                    {manualName ? 'Choose from staff list' : 'Enter name manually'}
                </button>
                <label className="sr-only" htmlFor="portal-auth-pin">Personal PIN</label>
                <input
                    id="portal-auth-pin"
                    type="password"
                    className={safeTheme ? 'input' : 'st-input'}
                    placeholder={safeTheme ? 'PIN' : 'PERSONAL PIN'}
                    aria-label="Personal PIN"
                    inputMode="numeric"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    style={safeTheme ? undefined : {
                        textAlign: 'center',
                        marginBottom: 12,
                        fontSize: '1.1em',
                        letterSpacing: '8px',
                        width: '100%',
                    }}
                />
                <button
                    type="submit"
                    className={safeTheme ? 'btn btn-warn' : 'st-btn'}
                    style={safeTheme ? { width: '100%' } : undefined}
                    disabled={loading}
                >
                    {loading ? (safeTheme ? 'VERIFYING...' : '…') : buttonLabel}
                </button>
                {status ? (
                    <p role="alert" style={{ fontSize: '0.75rem', color: '#f33', minHeight: 16, marginTop: 8, textTransform: 'none' }}>{status}</p>
                ) : null}
                <p className={safeTheme ? 'hint' : undefined} style={{ marginTop: 16, fontSize: '0.75em', textTransform: 'none' }}>
                    <Link to={backTo} style={{ color: safeTheme ? '#9c0' : '#00e5ff' }}>{backLabel}</Link>
                </p>
            </form>
        </div>
    );
}
