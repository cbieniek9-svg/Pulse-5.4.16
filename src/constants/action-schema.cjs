'use strict';

const ACTION_SCHEMAS = {
    tasks:           { actions: ['insert', 'update', 'delete'], idCols: ['task_id'], columns: ['task_id', 'task_detail', 'status', 'priority', 'zone', 'assigned_to', 'est_mins', 'time_submitted', 'time_closed', 'closed_by', 'related_id', 'start_time'] },
    oos:             { actions: ['insert', 'update'], idCols: ['oos_id'], columns: ['oos_id', 'zone', 'hole_count', 'notes', 'status', 'logged_by', 'time_logged', 'closed_by', 'time_closed'] },
    special_orders:  { actions: ['insert', 'update'], idCols: ['order_id'], columns: ['order_id', 'customer', 'item', 'contact', 'location', 'status', 'logged_by', 'time_logged', 'closed_by', 'time_closed', 'route', 'needed_by', 'source', 'taken_by', 'ordered_at', 'ready_at', 'customer_id', 'notes', 'notes_updated_at', 'notes_updated_by'] },
    expected_orders: { actions: ['insert', 'update', 'hardware_arrive', 'hardware_unarrive', 'receiving_mark_arrived', 'receiving_mark_departed', 'receiving_log_arrival'], idCols: ['exp_id'], columns: ['exp_id', 'vendor', 'expected_day', 'status', 'logged_by', 'closed_by', 'time_closed', 'category', 'pieces', 'arrived', 'arrived_at', 'arrived_by', 'departed_at', 'departed_by', 'item', 'create_task', 'invoice_ref'] },
    staff:           { actions: ['insert', 'update', 'delete'], idCols: ['id'], columns: ['name', 'active', 'pin', 'app_access', 'role', 'experimental_mode', 'last_review', 'availability', 'permissions', 'shift_lead_eligible'] },
    ticker:          { actions: ['insert', 'delete'], idCols: ['msg_id'], columns: ['msg_id', 'message'] },
    counts:          { actions: ['update'], idCols: ['id'], columns: ['grocery', 'frozen', 'hardware', 'staff', 'frozen_staff'] },
    settings:        { actions: ['update'], idCols: ['setting_name'], columns: ['setting_value'] },
    rhythm_tasks:    { actions: ['insert', 'update', 'delete'], idCols: ['id'], columns: ['id', 'day', 'detail', 'priority', 'zone', 'est_mins', 'assign_bucket'] },
    vendor_schedule: { actions: ['insert', 'update', 'delete'], idCols: ['id'], columns: ['id', 'day', 'vendor'] },
    shrink_log:      { actions: ['insert'], idCols: ['id'], columns: ['id', 'item', 'reason', 'cost', 'status', 'logged_by', 'time_logged'] },
    kill_dates:      { actions: ['insert', 'update'], idCols: ['id'], columns: ['id', 'item', 'item_code', 'kill_date', 'zone', 'status', 'logged_by', 'closed_by', 'time_closed', 'quantity'] },
};

module.exports = { ACTION_SCHEMAS };
