import { Outlet } from 'react-router-dom';
import { SyncProvider } from '../providers/SyncProvider.jsx';

export default function FloorLayout() {
    return (
        <SyncProvider>
            <Outlet />
        </SyncProvider>
    );
}
