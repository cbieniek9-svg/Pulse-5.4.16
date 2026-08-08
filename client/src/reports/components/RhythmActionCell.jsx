import { useState } from 'react';
import { useReportsContext } from '../context/ReportsContext.jsx';

export default function RhythmActionCell({ row }) {
    const { runAction, api } = useReportsContext();
    const [busy, setBusy] = useState(false);
    const suggestEst = row.avg_actual_mins;
    const biased = row.status === 'under_estimated' || row.status === 'over_estimated';

    const handleApply = async () => {
        setBusy(true);
        try {
            await runAction(() => api.applyRhythmEstimate(row.task_type, Number(suggestEst)));
        } finally {
            setBusy(false);
        }
    };

    const handleAdd = async () => {
        setBusy(true);
        try {
            await runAction(() => api.addRhythmFromReport(
                row.task_type,
                Number(suggestEst),
                Number(row.sample_count || 0),
            ));
        } finally {
            setBusy(false);
        }
    };

    if (row.has_rhythm_template && biased && suggestEst) {
        return (
            <button
                type="button"
                className="btn ok"
                style={{ padding: '2px 8px', fontSize: '0.65rem' }}
                disabled={busy}
                onClick={handleApply}
            >
                APPLY {suggestEst}M
            </button>
        );
    }
    if (row.can_add_to_rhythm && suggestEst) {
        return (
            <button
                type="button"
                className="btn warn"
                style={{ padding: '2px 8px', fontSize: '0.65rem' }}
                disabled={busy}
                onClick={handleAdd}
            >
                ADD TO RHYTHM
            </button>
        );
    }
    if (row.has_rhythm_template) {
        return <span style={{ color: '#b0b0b0', fontSize: '0.65rem', textTransform: 'none' }}>In rhythm</span>;
    }
    if (row.task_type === 'PULL:*') {
        return <span style={{ color: '#b0b0b0', fontSize: '0.65rem', textTransform: 'none' }}>Grouped pulls</span>;
    }
    if (Number(row.sample_count || 0) < 3) {
        return <span style={{ color: '#b0b0b0', fontSize: '0.65rem', textTransform: 'none' }}>Need 3+ samples</span>;
    }
    return '—';
}
