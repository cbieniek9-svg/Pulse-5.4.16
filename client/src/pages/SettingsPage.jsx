import PortalAuth from '../components/shared/PortalAuth.jsx';
import SettingsApp from '../settings/SettingsApp.jsx';

export default function SettingsPage() {
    return (
        <PortalAuth
            title="SETTINGS EDITOR"
            subtitle="Manager login required. Uses the same PIN as TGP Center Store."
            buttonLabel="UNLOCK SETTINGS"
            requireManager
        >
            <SettingsApp />
        </PortalAuth>
    );
}
