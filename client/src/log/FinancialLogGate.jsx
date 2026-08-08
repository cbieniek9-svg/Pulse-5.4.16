import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { claimFinancialLogShadow, fetchFinancialLogAccess } from './logApi.js';

export default function FinancialLogGate({ children }) {
    const { token, user } = useAuth();
    const [access, setAccess] = useState(null);
    const [error, setError] = useState('');
    const [claiming, setClaiming] = useState(false);

    const loadAccess = useCallback(async () => {
        if (!token) return;
        try {
            const payload = await fetchFinancialLogAccess(token);
            setAccess(payload.access || null);
            setError('');
        } catch (e) {
            setError(e.message || 'Could not verify Financial Log access.');
        }
    }, [token]);

    useEffect(() => {
        loadAccess();
    }, [loadAccess]);

    const handleClaim = async () => {
        if (!window.confirm(`Enable Financial Log shadow mode for ${user}? Only your account will see this portal until shadow mode is turned off.`)) {
            return;
        }
        setClaiming(true);
        try {
            const payload = await claimFinancialLogShadow(token);
            setAccess(payload.access || null);
            setError('');
        } catch (e) {
            setError(e.message || 'Could not claim shadow access.');
        } finally {
            setClaiming(false);
        }
    };

    if (!access) {
        return (
            <main id="main" className="log-shadow-gate">
                {error ? <div className="log-error">{error}</div> : <div className="log-panel-empty">Checking access…</div>}
            </main>
        );
    }

    if (access.can_access) {
        return children;
    }

    return (
        <main id="main" className="log-shadow-gate">
            <div className="log-shadow-card">
                <h2>Financial Log — shadow mode</h2>
                <p>
                    This portal is being tested privately before store rollout. It is not visible to other managers yet.
                </p>
                {access.can_claim ? (
                    <>
                        <p>
                            No shadow user is assigned yet. Claim access to run the workbook against live data while you validate totals and workflow.
                        </p>
                        <button type="button" className="log-btn" disabled={claiming} onClick={handleClaim}>
                            {claiming ? 'Enabling…' : `Enable shadow access for ${user}`}
                        </button>
                    </>
                ) : (
                    <p>
                        Shadow access is assigned to <strong>{access.allowlist.join(', ')}</strong>.
                        Contact that manager or turn off shadow mode in settings when ready for rollout.
                    </p>
                )}
                {error ? <div className="log-error">{error}</div> : null}
                <div className="log-footer" style={{ marginTop: 24 }}>
                    <Link to="/">← Back to TGP Center Store</Link>
                </div>
            </div>
        </main>
    );
}
