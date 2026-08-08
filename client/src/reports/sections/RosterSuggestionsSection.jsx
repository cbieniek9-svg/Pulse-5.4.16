import { mins } from '../lib/format.jsx';
import { rosterSuggestionConfidenceLabel } from '../lib/reportHelpers.js';

function RosterSuggestionCard({ suggestion, isTop }) {
    return (
        <div className={`roster-suggestion-card${isTop ? ' top' : ''}`}>
            <div className="rank">#{suggestion.rank} · {rosterSuggestionConfidenceLabel(suggestion.confidence)}</div>
            <div className="crew">{suggestion.roster_label || ''}</div>
            <div className="stats">
                {suggestion.avg_adj_pph != null ? `${Number(suggestion.avg_adj_pph).toFixed(1)} adj/person` : '—'}
                {' · '}
                {suggestion.avg_team_pph != null ? `${Number(suggestion.avg_team_pph).toFixed(1)} team` : '—'}
                {' · '}
                {suggestion.avg_pieces ?? '—'} avg pcs
                {' · '}
                {suggestion.avg_minutes ? mins(Math.round(suggestion.avg_minutes)) : '—'}
            </div>
        </div>
    );
}

export default function RosterSuggestionsSection({ data, highlightWeekday = null, compact = false }) {
    const rosterData = data.roster_suggestions_by_weekday;
    if (!rosterData) return null;

    const tagged = Number(rosterData.roster_tagged_days || 0);
    const total = Number(rosterData.total_order_days || 0);

    if (!tagged) {
        return (
            <div style={{ marginTop: compact ? 12 : 16 }} id="sec-roster-suggestions">
                <div className="section-title" style={{ marginBottom: 6 }}>SUGGESTED ORDER CREWS</div>
                <p className="roster-suggestion-empty">
                    Tag order crews in the history table above (comma-separated names + SAVE). Once a few order days have rosters, this section will rank the best crews for each Sunday, Tuesday, and Thursday order.
                </p>
            </div>
        );
    }

    return (
        <div style={{ marginTop: compact ? 12 : 16 }} id="sec-roster-suggestions">
            <div className="section-title" style={{ marginBottom: 6 }}>SUGGESTED ORDER CREWS — BY ORDER DAY</div>
            {compact ? (
                <p style={{ fontSize: '0.68rem', color: '#888', margin: '0 0 8px', textTransform: 'none' }}>
                    Best crews on past {highlightWeekday || 'this'} orders — ranked by avg adj/person PPH.
                </p>
            ) : (
                <p style={{ fontSize: '0.72rem', color: '#888', margin: '-2px 0 10px', textTransform: 'none' }}>
                    Ranked by avg adj/person PPH on that weekday only. {tagged} of {total} archived order days have crew tags. #1 in each column is the suggested starting crew.
                </p>
            )}
            <div className="roster-suggestions-grid">
                {(rosterData.by_weekday || []).map((day) => {
                    const highlight = highlightWeekday && day.weekday === highlightWeekday;
                    return (
                        <div key={day.weekday} className={`roster-suggestion-day${highlight ? ' highlight' : ''}`}>
                            <div className="roster-suggestion-day-title">{day.weekday} ORDER{highlight ? ' · TODAY' : ''}</div>
                            {day.suggestions.length ? day.suggestions.map((s, i) => (
                                <RosterSuggestionCard key={s.rank} suggestion={s} isTop={i === 0} />
                            )) : (
                                <p className="roster-suggestion-empty">
                                    {day.weekday}: {day.roster_tagged_days || 0} tagged of {day.sample_order_days || 0} archived orders — add more {day.weekday} rosters to get a suggestion.
                                </p>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export function RosterPerformanceSection({ data }) {
    const rollup = data.roster_performance_rollup || [];
    if (!rollup.length) {
        return (
            <div style={{ marginTop: 16 }} id="sec-roster-performance">
                <div className="section-title" style={{ marginBottom: 6 }}>ORDER CREW PERFORMANCE</div>
                <p style={{ fontSize: '0.72rem', color: '#b0b0b0', textTransform: 'none' }}>
                    Add comma-separated order crew names in the history table above — matching crews are grouped here by adjusted PPH.
                </p>
            </div>
        );
    }

    return (
        <div style={{ marginTop: 16 }} id="sec-roster-performance">
            <div className="section-title" style={{ marginBottom: 6 }}>ORDER CREW PERFORMANCE — BY ROSTER</div>
            <p style={{ fontSize: '0.72rem', color: '#888', margin: '-2px 0 10px', textTransform: 'none' }}>
                Grouped by crew (same names, any order). Top row is highest avg adj/person PPH. Edit rosters in the table above to backfill missing crews.
            </p>
            <div className="tbl-wrap">
                <table className="roster-rollup-table">
                    <tbody>
                        <tr><th>ORDER CREW</th><th>SIZE</th><th>RUNS</th><th>AVG PCS</th><th>AVG DUR</th><th>AVG TEAM PPH</th><th>AVG ADJ/PER</th><th>RECENT DATES</th></tr>
                        {rollup.map((r, i) => (
                            <tr key={r.roster_label} style={i === 0 ? { background: 'rgba(0,248,136,0.06)' } : undefined}>
                                <td style={{ color: 'var(--white)', fontWeight: 700 }}>{r.roster_label || ''}</td>
                                <td>{r.staff_count ?? '—'}</td>
                                <td>{r.samples ?? '—'}</td>
                                <td>{r.avg_pieces ?? '—'}</td>
                                <td>{r.avg_minutes ? mins(Math.round(r.avg_minutes)) : '—'}</td>
                                <td>{r.avg_team_pph != null ? Number(r.avg_team_pph).toFixed(1) : '—'}</td>
                                <td>{r.avg_adj_pph != null ? Number(r.avg_adj_pph).toFixed(1) : '—'}</td>
                                <td style={{ fontSize: '0.68rem', color: 'var(--text)' }}>{(r.recent_dates || []).join(', ')}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
