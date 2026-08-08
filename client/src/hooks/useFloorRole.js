import { useMemo } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { isManagerRole } from '../lib/roles.js';
import { useSync } from '../providers/SyncProvider.jsx';

export function useFloorRole() {
    const { user } = useAuth();
    const { syncData } = useSync();

    return useMemo(() => {
        const staff = syncData?.staff || [];
        const me = staff.find((s) => s.name === user);
        const isManager = isManagerRole(me?.role);
        const isPremium = me?.role === 'Premium Clerk';
        const perms = (me?.permissions || '').split(',').filter(Boolean);

        return {
            me,
            isManager,
            isPremium,
            perms,
            canManageTasks: isManager || isPremium,
            canCompleteTasks: isManager || isPremium || perms.includes('tasks'),
            canFinishOrder: isManager || isPremium,
            canEditSchedule: isManager || isPremium,
            showReceiving: isManager || perms.includes('receiving'),
            showMarkdown: isManager || perms.includes('markdown'),
            showComms: isManager || perms.includes('comms'),
            showOpsLogging: isManager || isPremium || perms.includes('tasks'),
            showPremOnly: isManager || isPremium,
            showMgrOnly: isManager,
        };
    }, [user, syncData]);
}
