export const LOG_NAV_GROUPS = [
    {
        id: 'overview',
        label: 'Overview',
        tabs: [
            { id: 'overview', label: 'Period Checklist' },
            { id: 'dock-reconcile', label: 'Dock Reconcile' },
            { id: 'help', label: 'How to Use' },
        ],
    },
    {
        id: 'daily',
        label: 'Daily',
        tabs: [
            { id: 'sheet', label: 'Receiving' },
            { id: 'shrink', label: 'Shrink' },
            { id: 'total-report', label: 'Total Report' },
        ],
    },
    {
        id: 'sales',
        label: 'Sales',
        tabs: [
            { id: 'sales', label: 'Sales Numbers' },
            { id: 'sales-data', label: 'Sales Data' },
        ],
    },
    {
        id: 'margin',
        label: 'Margin',
        tabs: [
            { id: 'margin', label: 'Total Grocery' },
            { id: 'dept-centre-store', label: 'Centre Store' },
            { id: 'dept-dairy', label: 'Dairy' },
            { id: 'dept-meat', label: 'Meat' },
            { id: 'dept-produce', label: 'Produce' },
            { id: 'dept-tobacco', label: 'Tobacco' },
            { id: 'margin-ytd', label: 'Margin YTD' },
            { id: 'count-cycle', label: 'Count Cycle' },
        ],
    },
    {
        id: 'close',
        label: 'Period Close',
        tabs: [
            { id: 'receiving-totals', label: 'Receiving Totals' },
            { id: 'rebates', label: 'Rebates' },
            { id: 'recounts', label: 'Recounts' },
        ],
    },
];

export const PERIOD_TABS = new Set([
    'overview',
    'dock-reconcile',
    'help',
    'sales',
    'sales-data',
    'receiving-totals',
    'margin',
    'total-report',
    'rebates',
    'recounts',
    'margin-ytd',
    'count-cycle',
    'dept-tobacco',
    'dept-meat',
    'dept-produce',
    'dept-dairy',
    'dept-centre-store',
]);

export const DEPT_TAB_MAP = {
    'dept-tobacco': 'tobacco',
    'dept-meat': 'meat',
    'dept-produce': 'produce',
    'dept-dairy': 'dairy',
    'dept-centre-store': 'centre_store',
};

export const STORAGE_KEY = 'log-portal-state';

export function findGroupForTab(tabId) {
    return LOG_NAV_GROUPS.find((group) => group.tabs.some((tab) => tab.id === tabId)) || LOG_NAV_GROUPS[0];
}

export function readPortalState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

export function writePortalState(state) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {
        // ignore quota errors
    }
}
