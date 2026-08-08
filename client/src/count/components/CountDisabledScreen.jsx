import { Link } from 'react-router-dom';

export default function CountDisabledScreen() {
    return (
        <div className="disabled-screen">
            <div className="auth-box">
                <div className="title" style={{ color: '#f90', marginBottom: 12 }}>INVENTORY COUNT</div>
                <p className="hint" style={{ color: '#8cf', margin: '0 0 12px' }}>
                    This portal is turned off until SMS integration or a superseding count flow is ready.
                </p>
                <p className="hint" style={{ margin: '0 0 16px' }}>
                    Managers can enable it in <strong style={{ color: '#fff' }}>Settings → Store &amp; TV</strong> → Inventory count.
                </p>
                <Link className="btn btn-secondary" to="/settings" style={{ display: 'inline-block', textDecoration: 'none', marginBottom: 10 }}>
                    OPEN SETTINGS
                </Link>
                <Link className="btn btn-secondary" to="/" style={{ display: 'inline-block', textDecoration: 'none' }}>
                    HOME
                </Link>
            </div>
        </div>
    );
}
