import { useEffect, useMemo, useState } from 'react';
import { formatMoney, formatPct } from './logAnalyticsUtils.js';
import {
    fetchFreightAllocProfile,
    saveFreightAllocProfile,
    confirmFreightAllocProfile,
    copyFreightAllocProfile,
    setActualFreightBills,
} from './logApi.js';

const DEPT_FIELDS = [
    { key: 'grocery', label: 'Grocery' },
    { key: 'tobacco', label: 'Tobacco' },
    { key: 'meat', label: 'Meat' },
    { key: 'bakery', label: 'Bakery' },
    { key: 'bakery_in_store', label: 'Bake off' },
    { key: 'deli', label: 'Deli' },
    { key: 'produce', label: 'Produce' },
    { key: 'produce_shrink', label: 'Produce Shrink' },
    { key: 'dairy', label: 'Dairy' },
    { key: 'pharmacy', label: 'Pharmacy' },
];

const EMPTY_PCT = Object.fromEntries(DEPT_FIELDS.map((d) => [d.key, '']));

function ModeCard({ mode, primary, variant = 'default' }) {
    if (!mode) return null;
    const unavailable = mode.available === false || mode.cogs == null;
    const isPrimaryAlloc = variant === 'primary_alloc';
    const isSupersededRate = variant === 'superseded_rate';
    const purchaseLabel = isPrimaryAlloc
        ? 'Daily Freight Allocation Total'
        : (isSupersededRate ? 'Eligible Merchandise Purchases' : 'Base Purchases');
    const purchaseValue = isPrimaryAlloc && mode.daily_freight_allocation_total != null
        ? mode.daily_freight_allocation_total
        : mode.base_purchases;
    const freightLabel = isPrimaryAlloc
        ? 'Department Allocated Freight'
        : (mode.id === 'invoice_freight' ? 'Invoice Estimated Freight — Reference Only' : 'Allocated Freight');
    return (
        <div className={`costing-compare-card${primary ? ' highlight' : ''}${unavailable ? ' muted' : ''}`}>
            <div className="costing-compare-label">{mode.label}</div>
            <div className="costing-compare-blurb">{mode.blurb}</div>
            <div className="costing-compare-row">
                <span>{purchaseLabel}</span>
                <strong>{unavailable ? 'Unavailable' : formatMoney(purchaseValue)}</strong>
            </div>
            <div className="costing-compare-row">
                <span>{freightLabel}</span>
                <strong>{unavailable ? 'Unavailable' : formatMoney(mode.freight_included)}</strong>
            </div>
            <div className="costing-compare-row">
                <span>Landed Purchase Cost</span>
                <strong>{unavailable ? 'Unavailable' : formatMoney(mode.landed_purchases ?? mode.grocery_dairy_purchases)}</strong>
            </div>
            <div className="costing-compare-row">
                <span>COGS</span>
                <strong>{unavailable ? 'Unavailable' : formatMoney(mode.cogs)}</strong>
            </div>
            <div className="costing-compare-row">
                <span>GP $</span>
                <strong>{unavailable ? 'Unavailable' : formatMoney(mode.gross_profit)}</strong>
            </div>
            <div className="costing-compare-row">
                <span>Margin %</span>
                <strong>{unavailable ? 'Unavailable' : formatPct(mode.gross_margin_pct)}</strong>
            </div>
            <div className="costing-compare-row muted">
                <span>vs SMS margin</span>
                <strong>{unavailable ? '—' : formatPct(mode.gp_diff_vs_sms_pct)}</strong>
            </div>
            {mode.difference_from_primary && primary === false ? (
                <div className="costing-compare-row muted">
                    <span>Δ from primary GP</span>
                    <strong>{formatMoney(mode.difference_from_primary.gross_profit)}</strong>
                </div>
            ) : null}
        </div>
    );
}

/**
 * Period department allocation profile (authoritative) vs invoice estimate (reference)
 * vs superseded period_rate vs base-cost diagnostic.
 */
export default function LogCostingComparisonBanner({
    comparison,
    periodStart = '',
    token = '',
    readOnly = false,
    onConfirmMethod,
    onRatesChanged,
}) {
    const [pctInputs, setPctInputs] = useState(EMPTY_PCT);
    const [billsInput, setBillsInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [profileMeta, setProfileMeta] = useState(null);

    useEffect(() => {
        let cancelled = false;
        if (!token || !periodStart) return undefined;
        fetchFreightAllocProfile(token, periodStart)
            .then((res) => {
                if (cancelled) return;
                setProfileMeta(res?.profile || null);
                const map = res?.profile?.pct_map || {};
                const next = { ...EMPTY_PCT };
                DEPT_FIELDS.forEach(({ key }) => {
                    next[key] = map[key] == null || map[key] === '' ? '' : String(map[key]);
                });
                setPctInputs(next);
                if (res?.actual_freight_bills_total != null) {
                    setBillsInput(String(res.actual_freight_bills_total));
                }
            })
            .catch(() => {
                if (!cancelled) setProfileMeta(null);
            });
        return () => { cancelled = true; };
    }, [token, periodStart, comparison?.alloc_profile_status, comparison?.missing_alloc_profile]);

    const liveTotal = useMemo(() => (
        DEPT_FIELDS.reduce((sum, { key }) => {
            const n = Number(pctInputs[key]);
            return sum + (Number.isFinite(n) ? n : 0);
        }, 0)
    ), [pctInputs]);
    const totalOk = Math.abs(liveTotal - 100) <= 0.0001;
    const status = profileMeta?.status || comparison?.alloc_profile_status || 'missing';
    const confirmed = status === 'confirmed';

    if (!comparison?.modes) return null;

    const periodAlloc = comparison.modes.period_department_allocation
        || comparison.modes.legacy_fixed_allocation
        || comparison.modes.workbook_alloc;
    const periodRate = comparison.modes.period_rate;
    const invoice = comparison.modes.invoice_freight;
    const baseOnly = comparison.modes.base_cost_only || comparison.modes.sms_landed;
    const primaryId = comparison.primary_method || comparison.primary_mode;
    const departments = comparison.departments || [];
    const validation = comparison.freight_validation_variance || comparison.freight_validation || null;
    const missingProfile = !!comparison.missing_alloc_profile
        || periodAlloc?.missing_alloc_profile === true
        || status === 'missing';

    const buildPctMap = () => {
        const map = {};
        DEPT_FIELDS.forEach(({ key }) => {
            const n = Number(pctInputs[key]);
            map[key] = Number.isFinite(n) ? n : 0;
        });
        return map;
    };

    const saveProfile = async () => {
        if (!token || !periodStart) return;
        setBusy(true);
        try {
            const res = await saveFreightAllocProfile(token, {
                period_start: periodStart,
                departments: buildPctMap(),
            });
            setProfileMeta(res?.profile || null);
            if (onRatesChanged) await onRatesChanged();
        } catch (error) {
            alert(error.message || 'Could not save allocation profile.');
        } finally {
            setBusy(false);
        }
    };

    const confirmProfile = async () => {
        if (!token || !periodStart || !totalOk) return;
        const reason = window.prompt('Manager reason for confirming department allocation profile:');
        if (!reason?.trim()) return;
        setBusy(true);
        try {
            await saveFreightAllocProfile(token, {
                period_start: periodStart,
                departments: buildPctMap(),
            });
            const res = await confirmFreightAllocProfile(token, {
                period_start: periodStart,
                reason: reason.trim(),
            });
            setProfileMeta(res?.profile || null);
            if (onRatesChanged) await onRatesChanged();
        } catch (error) {
            alert(error.message || 'Could not confirm allocation profile.');
        } finally {
            setBusy(false);
        }
    };

    const copyPrevious = async () => {
        if (!token || !periodStart) return;
        setBusy(true);
        try {
            const res = await copyFreightAllocProfile(token, { period_start: periodStart });
            setProfileMeta(res?.profile || null);
            const map = res?.profile?.pct_map || {};
            const next = { ...EMPTY_PCT };
            DEPT_FIELDS.forEach(({ key }) => {
                next[key] = map[key] == null || map[key] === '' ? '' : String(map[key]);
            });
            setPctInputs(next);
            if (onRatesChanged) await onRatesChanged();
        } catch (error) {
            alert(error.message || 'Could not copy previous period profile.');
        } finally {
            setBusy(false);
        }
    };

    const saveBills = async () => {
        if (!token || !periodStart) return;
        const trimmed = String(billsInput || '').trim();
        const n = trimmed === '' ? null : Number(trimmed);
        if (trimmed !== '' && !Number.isFinite(n)) {
            alert('Enter a valid actual freight bills total, or leave blank.');
            return;
        }
        setBusy(true);
        try {
            await setActualFreightBills(token, {
                period_start: periodStart,
                actual_freight_bills_total: n,
            });
            if (onRatesChanged) await onRatesChanged();
        } catch (error) {
            alert(error.message || 'Could not save actual freight bills total.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="costing-compare" data-testid="costing-comparison">
            <div className="costing-compare-head">
                <strong>Costing comparison</strong>
                <span>{comparison.note}</span>
                <span className="costing-rate-chip">
                    Daily Freight Allocation Total × Period Department Allocation %
                </span>
                <span className={`costing-rate-chip${confirmed ? '' : ' costing-rate-missing'}`}>
                    Profile: {status}
                </span>
                {missingProfile ? (
                    <span className="costing-rate-chip costing-rate-missing" data-testid="freight-alloc-profile-missing">
                        Allocation profile missing
                    </span>
                ) : null}
            </div>

            {!readOnly && token && periodStart ? (
                <div className="costing-rate-config" data-testid="period-freight-alloc-profile-config">
                    <div className="costing-rate-config-row">
                        <strong>Period department allocation %</strong>
                        <span className="hint">
                            Live total: {liveTotal.toFixed(2)}%
                            {totalOk ? ' ✓' : ' (must equal 100%)'}
                        </span>
                    </div>
                    <div className="costing-alloc-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: '0.5rem' }}>
                        {DEPT_FIELDS.map(({ key, label }) => (
                            <label key={key} htmlFor={`alloc-pct-${key}`}>
                                {label}
                                <input
                                    id={`alloc-pct-${key}`}
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    max="100"
                                    value={pctInputs[key]}
                                    disabled={busy || confirmed}
                                    onChange={(e) => setPctInputs((prev) => ({ ...prev, [key]: e.target.value }))}
                                />
                            </label>
                        ))}
                    </div>
                    <div className="costing-rate-config-row">
                        <button
                            type="button"
                            className="log-btn log-btn-secondary log-btn-small"
                            disabled={busy || confirmed}
                            onClick={saveProfile}
                        >
                            Save draft
                        </button>
                        <button
                            type="button"
                            className="log-btn log-btn-secondary log-btn-small"
                            disabled={busy || confirmed || !totalOk}
                            onClick={confirmProfile}
                            data-testid="confirm-alloc-profile"
                        >
                            Confirm profile
                        </button>
                        <button
                            type="button"
                            className="log-btn log-btn-secondary log-btn-small"
                            disabled={busy || confirmed}
                            onClick={copyPrevious}
                        >
                            Copy from previous period
                        </button>
                        {onConfirmMethod ? (
                            <button
                                type="button"
                                className="log-btn log-btn-secondary log-btn-small"
                                disabled={busy || !confirmed}
                                onClick={() => onConfirmMethod('period_department_allocation')}
                            >
                                Confirm costing method
                            </button>
                        ) : null}
                        {profileMeta?.updated_at ? (
                            <span className="hint">
                                Updated {profileMeta.updated_at}
                                {profileMeta.updated_by ? ` · ${profileMeta.updated_by}` : ''}
                            </span>
                        ) : (
                            <span className="hint">Accounting period {periodStart}</span>
                        )}
                    </div>
                    <div className="costing-rate-config-row">
                        <label htmlFor="actual-freight-bills-input">
                            Actual freight bills — Freight Bill Validation Variance
                            <input
                                id="actual-freight-bills-input"
                                type="number"
                                step="0.01"
                                value={billsInput}
                                disabled={busy}
                                onChange={(e) => setBillsInput(e.target.value)}
                            />
                        </label>
                        <button
                            type="button"
                            className="log-btn log-btn-secondary log-btn-small"
                            disabled={busy}
                            onClick={saveBills}
                        >
                            Save bills total
                        </button>
                        <span className="hint">
                            Variance = bills − sum of Daily Freight Allocation Totals. Does not change allocation.
                        </span>
                    </div>
                    {validation ? (
                        <div className="costing-rate-config-row" data-testid="freight-validation-variance">
                            <span>
                                Freight Bill Validation Variance:{' '}
                                <strong>
                                    {validation.variance == null
                                        ? 'incomplete bill coverage'
                                        : formatMoney(validation.variance)}
                                </strong>
                                {validation.pct_variance != null ? ` (${validation.pct_variance}%)` : ''}
                            </span>
                        </div>
                    ) : null}
                </div>
            ) : null}

            <div className="costing-compare-grid costing-compare-grid-4">
                <ModeCard
                    mode={periodAlloc}
                    variant="primary_alloc"
                    primary={primaryId === 'period_department_allocation' || primaryId === 'legacy_fixed_allocation' || primaryId === 'workbook_alloc'}
                />
                <ModeCard mode={periodRate} variant="superseded_rate" primary={false} />
                <ModeCard mode={invoice} primary={false} />
                <ModeCard mode={baseOnly} primary={false} />
            </div>
            {departments.length ? (
                <div className="costing-compare-depts" data-testid="costing-dept-table">
                    <table>
                        <thead>
                            <tr>
                                <th>Department</th>
                                <th>Eligible Merchandise Purchases</th>
                                <th>Department Allocated Freight</th>
                                <th>Invoice Estimated Freight — Reference Only</th>
                                <th>Superseded purchases × rate</th>
                                <th>Freight Bill Validation Variance</th>
                                <th>GP effect</th>
                                <th>Margin effect</th>
                            </tr>
                        </thead>
                        <tbody>
                            {departments.map((row) => (
                                <tr key={row.department}>
                                    <td>{row.department}</td>
                                    <td>{formatMoney(row.base_purchases)}</td>
                                    <td>{formatMoney(row.period_allocated_freight)}</td>
                                    <td>{formatMoney(row.invoice_estimated_freight_reference ?? row.invoice_freight)}</td>
                                    <td>{formatMoney(row.superseded_period_rate_freight ?? row.legacy_freight)}</td>
                                    <td>{formatMoney(row.freight_variance)}</td>
                                    <td>{formatMoney(row.gp_effect)}</td>
                                    <td>{row.margin_effect == null ? '—' : formatPct(row.margin_effect)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : null}
        </div>
    );
}
