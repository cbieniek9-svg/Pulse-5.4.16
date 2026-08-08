import { useFloorUi } from '../../shared/NoticeProvider.jsx';

export default function SystemAdminPanel() {
    const { actions, showNotice } = useFloorUi();

    return (
        <>
            <p style={{ margin: '0 0 12px', fontSize: '0.75em', color: '#888', textTransform: 'none' }}>
                TV dashboard URL and device pairing: <a href="/settings?tab=devices" target="_blank" rel="noopener" style={{ color: '#0cf' }}>Settings Editor → TV &amp; Devices</a>
            </p>
            <button type="button" className="st-btn" style={{ marginBottom: 10 }} onClick={() => actions.downloadProtectedFile('/api/export-csv', 'TGP_Data_Dump.csv').then(() => showNotice('File downloaded', 'success')).catch((e) => showNotice(e.message, 'error'))}>
                📥 EXPORT CSV DATA
            </button>
            <button type="button" className="st-btn" style={{ marginBottom: 20 }} onClick={() => actions.downloadProtectedFile('/api/backup-db', 'TGP_Backup.db').then(() => showNotice('Verified backup downloaded', 'success')).catch((e) => showNotice(e.message, 'error'))}>
                💾 BACKUP DATABASE
            </button>
            <button
                type="button"
                className="st-btn"
                style={{ borderColor: '#f33', color: '#f33', marginBottom: 10 }}
                onClick={() => actions.triggerEodSweep().then((result) => {
                    if (!result) return;
                    if (result.recovered_post_backup) {
                        showNotice(
                            'EOD recovered: post-purge backup completed after a previous incomplete run.',
                            'success',
                        );
                    } else if (result.skipped && result.reason === 'already_swept') {
                        showNotice('EOD already complete for this store day.', 'success');
                    } else {
                        showNotice('EOD sweep complete', 'success');
                    }
                }).catch((e) => showNotice(e.message, 'error'))}
            >
                🚨 EXECUTE EOD SWEEP
            </button>
            <button type="button" className="st-btn" style={{ borderColor: '#f33', color: '#f33' }} onClick={() => actions.triggerClearDb().catch((e) => showNotice(e.message, 'error'))}>
                💀 WIPE DATABASE
            </button>
        </>
    );
}
