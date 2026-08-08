import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { fetchFinancialLogAccess } from './logApi.js';

export default function FinancialLogLink() {
    const { token, isAuthenticated } = useAuth();
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (!isAuthenticated || !token) {
            setVisible(false);
            return;
        }
        let cancelled = false;
        fetchFinancialLogAccess(token)
            .then((payload) => {
                if (!cancelled) setVisible(!!payload.access?.can_access);
            })
            .catch(() => {
                if (!cancelled) setVisible(false);
            });
        return () => { cancelled = true; };
    }, [isAuthenticated, token]);

    if (!visible) return null;

    return (
        <Link
            to="/financial"
            style={{
                display: 'inline-block',
                border: '1px solid #0f8',
                color: '#0f8',
                padding: '8px 20px',
                borderRadius: 20,
                fontSize: '0.8em',
                letterSpacing: 2,
                textDecoration: 'none',
            }}
        >
            📒 FINANCIAL LOG
        </Link>
    );
}
