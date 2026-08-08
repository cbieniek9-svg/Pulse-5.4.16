import AuthScreen from '../components/floor/AuthScreen.jsx';
import FloorApp from '../components/floor/FloorApp.jsx';
import { NoticeProvider } from '../components/shared/NoticeProvider.jsx';
import { useAuth } from '../lib/auth.jsx';

export default function FloorPage() {
    const { isAuthenticated } = useAuth();
    if (!isAuthenticated) return <AuthScreen />;
    return (
        <NoticeProvider>
            <FloorApp />
        </NoticeProvider>
    );
}
