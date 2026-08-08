import PortalAuth from '../components/shared/PortalAuth.jsx';
import RecApp from '../rec/RecApp.jsx';
import '../styles/rec.css';

export default function RecPage() {
    return (
        <PortalAuth
            title="RECEIVING UPLINK"
            buttonLabel="ENTER SYSTEM"
            backLabel="← Back to TGP Center Store"
        >
            <RecApp />
        </PortalAuth>
    );
}
