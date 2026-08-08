import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.jsx';
import '../../styles/portal-shell.css';

export default function PortalBackBar({
    backTo = '/',
    backLabel = '← FLOOR',
    showLogout = true,
}) {
    const { logout } = useAuth();

    return (
        <div className="portal-back-bar">
            <Link to={backTo} className="portal-back-link">{backLabel}</Link>
            {showLogout ? (
                <button
                    type="button"
                    className="portal-back-logout"
                    onClick={() => { logout(); window.location.reload(); }}
                >
                    LOGOUT
                </button>
            ) : null}
        </div>
    );
}
