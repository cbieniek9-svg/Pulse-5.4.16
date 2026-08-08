import { useCallback, useEffect, useState } from 'react';
import { getSync } from '../../lib/api.js';
import { usePortalStream } from '../../lib/usePortalStream.js';
import { fetchScheduleHealth } from '../lib/settingsApi.js';

export function useSettingsSync({ token, enabled = true }) {
    const [syncData, setSyncData] = useState(null);
    const [scheduleHealth, setScheduleHealth] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const refresh = useCallback(async () => {
        if (!token || !enabled) return null;
        setLoading(true);
        try {
            const data = await getSync(token);
            setSyncData(data);
            setError('');
            return data;
        } catch (e) {
            setError(e.message || 'Sync failed');
            throw e;
        } finally {
            setLoading(false);
        }
    }, [token, enabled]);

    const refreshScheduleHealth = useCallback(async () => {
        if (!token || !enabled) return null;
        try {
            const health = await fetchScheduleHealth(token);
            setScheduleHealth(health);
            return health;
        } catch (e) {
            setScheduleHealth(null);
            throw e;
        }
    }, [token, enabled]);

    useEffect(() => {
        if (!token || !enabled) return;
        refresh();
    }, [token, enabled, refresh]);

    const onStreamEvent = useCallback(() => {
        refresh();
    }, [refresh]);

    usePortalStream({
        token: enabled ? token : '',
        onEvent: onStreamEvent,
    });

    return {
        syncData,
        setSyncData,
        scheduleHealth,
        setScheduleHealth,
        loading,
        error,
        refresh,
        refreshScheduleHealth,
    };
}
