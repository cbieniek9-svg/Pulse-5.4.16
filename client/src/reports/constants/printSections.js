export const PRINT_SECTIONS = [
    { id: 'sec-daily-direction', label: 'Daily Direction', group: 'Today' },
    { id: 'sec-safety-focus', label: 'Safety Focus', group: 'Today' },
    { id: 'sec-actions', label: 'Action Inbox', group: 'Today' },
    { id: 'sec-presence', label: 'Presence Exceptions', group: 'Today' },
    { id: 'sec-oos', label: 'Out of Stock', group: 'Today' },
    { id: 'sec-markdown', label: 'Markdown / Kill Dates', group: 'Today' },
    { id: 'sec-homebase', label: 'Homebase Audits', group: 'Today' },
    { id: 'sec-trends', label: 'Trends & Insights', group: 'Learn' },
    { id: 'sec-planning', label: 'Task Planning', group: 'Learn' },
    { id: 'sec-orders-today', label: 'Order Today', group: 'Learn' },
    { id: 'sec-orders-learn', label: 'Order History', group: 'Learn' },
    { id: 'sec-roster-performance', label: 'Order Crew Performance', group: 'Learn' },
    { id: 'sec-roster-suggestions', label: 'Suggested Order Crews', group: 'Learn' },
    { id: 'sec-finish-health', label: 'Finish Archive Health', group: 'Learn' },
    { id: 'sec-labor-ledger', label: 'Labor Ledger', group: 'Learn' },
    { id: 'sec-exception-rollup', label: 'Exception Rollup', group: 'Learn' },
    { id: 'sec-staff-curve', label: 'Staff Count Curve', group: 'Learn' },
    { id: 'sec-action-logs', label: 'Action Logs', group: 'Learn' },
    { id: 'sec-floor-shrink', label: 'Floor Shrink Analytics', group: 'Learn' },
    { id: 'sec-summary', label: 'Shift Summary', group: 'Handoff' },
    { id: 'sec-order-roster', label: 'Order Crew (Finish)', group: 'Handoff' },
    { id: 'sec-comms', label: 'Comms Handoff Archive', group: 'Handoff' },
    { id: 'sec-staff', label: 'Staff on Shift', group: 'Handoff' },
    { id: 'sec-tasks', label: 'Tasks', group: 'Handoff' },
    { id: 'sec-customer-orders', label: 'Customer Orders', group: 'Handoff' },
    { id: 'sec-receiving', label: 'Receiving Performance', group: 'Handoff' },
    { id: 'sec-tgp-cold-chain', label: 'TGP Cold Chain', group: 'Handoff' },
    { id: 'sec-safety-inspections', label: 'Safety Inspections', group: 'Handoff' },
    { id: 'sec-receiving-recent', label: 'Recent Receiving Runs', group: 'Handoff' },
    { id: 'sec-deliveries', label: 'Delivery Receipts', group: 'Handoff' },
];

export const PRINT_PRESETS = {
    handoff: [
        'sec-summary', 'sec-safety-focus', 'sec-comms', 'sec-staff', 'sec-tasks',
        'sec-customer-orders', 'sec-receiving', 'sec-tgp-cold-chain', 'sec-deliveries',
    ],
    cold_chain: ['sec-tgp-cold-chain'],
    all: PRINT_SECTIONS.map((s) => s.id),
};

export const MODE_HINTS = {
    today: 'What do I need to act on right now? Daily Direction, Shift Updates, and Action Inbox.',
    learn: 'Weekly review — planning accuracy, scorecard health, trends, and what-if tools.',
    handoff: 'Close the shift — summary, comms archive, staff, receiving, and print handoff.',
};
