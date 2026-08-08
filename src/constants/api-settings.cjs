'use strict';

/** Settings keys never returned to anonymous `/api/sync` clients */
const SENSITIVE_SETTING_KEYS = new Set([
    'TV_ACCESS_KEY',
    'Presence_Gateway_Key',
    'Presence_Gateway_Map',
    'Presence_Staff_Beacons',
    'Presence_Cart_Map',
    'Presence_Order_Gateways',
]);

const CLERK_WRITABLE_SETTINGS = new Set([
    'Shift_Notes', 'Critical_Alert', 'Order_Start', 'Order_End',
    'Frozen_Order_Start', 'Frozen_Order_End',
    'Last_Actual_PPH', 'Active_Manager', 'Hardware_Arrived', 'Hardware_Pieces',
]);

const MANAGER_WRITABLE_SETTINGS = new Set([
    'TV_Scale', 'TV_Task_Size', 'TV_Col_Split', 'TV_KPI_Size', 'TV_Map_Size', 'TV_Native_Shell',
    'TV_Show_Pinned_Daily_Huddle', 'TV_Show_Store_Comms', 'TV_Show_Audit_Trail',
    'TV_Show_Ticker', 'TV_Show_Latest_Shift_Update',
    'Zone_Mapping', 'Zone_Ownership', 'Zone_Names', 'Zone_Section_Labels', 'FIFO_Aisle_Assignments', 'Schedule_Role_Buckets',
    'Cases_Per_Hour', 'flag.experimental_mode', 'TV_ACCESS_KEY',
    'Store_Code', 'Store_Display_Name', 'Store_Timezone',
    'Training_Mode_Enabled', 'Unassigned_Option_Enabled', 'Rhythm_Schedule_Edit_Enabled',
    'Betacs_Enabled', 'Cs_Full_Enabled', 'Cs_Hub_Enabled', 'Cs_Crm_Enabled',
    'Inventory_Count_Enabled',
    'Store_Transfers_Enabled',
    'Message_Center_Enabled', 'Comms_System_Messages',
    'Allow_LAN_Clients', 'LAN_Bind_Host', 'LAN_Port',
    'Operational_Retention_Days', 'Report_Trend_Window_Days',
    'Presence_Enabled', 'Presence_Gateway_Map', 'Presence_Staff_Beacons',
    'Presence_Cart_Map', 'Presence_Asset_Mode', 'Presence_Allow_Discovery',
    'Presence_Mismatch_Threshold',
    'Presence_Order_Gateways', 'Presence_Gateway_Stale_Minutes',
    'Presence_Zone_Window_Minutes', 'Presence_RSSI_Floor',
]);

module.exports = { SENSITIVE_SETTING_KEYS, CLERK_WRITABLE_SETTINGS, MANAGER_WRITABLE_SETTINGS };
