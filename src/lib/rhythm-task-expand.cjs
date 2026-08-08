'use strict';

/** SQL fragment — only human-closed tasks count toward learned estimates / task time metrics. */
const HUMAN_CLOSED_TASK_FILTER = "COALESCE(closed_by, '') NOT IN ('AUTO', 'Unassigned', '')";

const { expandRhythmTaskForBoard, buildRhythmAssignContext } = require('./rhythm-schedule-assign.cjs');

function isAutoClosedTask(task) {
    return String(task?.closed_by || '').trim() === 'AUTO';
}

module.exports = {
    HUMAN_CLOSED_TASK_FILTER,
    isAutoClosedTask,
    expandRhythmTaskForBoard,
    buildRhythmAssignContext,
};
