import PortalBackBar from '../components/shared/PortalBackBar.jsx';
import CsApp from '../cs/CsApp.jsx';
import '../styles/portal-shell.css';

export default function CsPage() {
    return (
        <>
            <PortalBackBar backLabel="← FLOOR" showLogout={false} />
            <CsApp />
        </>
    );
}
