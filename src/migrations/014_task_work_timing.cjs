'use strict';

module.exports = {
    name: 'task_work_timing_setting',
    up(db) {
        db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Task_Work_Timing_Enabled', '0')");
    },
};
