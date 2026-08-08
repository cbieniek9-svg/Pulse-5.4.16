'use strict';

const SETTING = 'Task_Work_Timing_Enabled';

function isTaskWorkTimingEnabled(settings = {}) {
    return settings[SETTING] === '1';
}

module.exports = { SETTING, isTaskWorkTimingEnabled };
