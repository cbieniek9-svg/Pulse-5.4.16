'use strict';

/**
 * Remove closed/archived markdown (kill_dates) rows and stale AUTO-PULL tasks.
 * Active expiry records on the live board are kept.
 * @param {object} db
 * @returns {{ removedKillDates: number, removedPullTasks: number, activeRemaining: number }}
 */
function clearMarkdownArchive(db) {
    let removedKillDates = 0;
    let removedPullTasks = 0;

    db.transaction(() => {
        removedKillDates = db.get("SELECT COUNT(*) as c FROM kill_dates WHERE status != 'Active'")?.c ?? 0;
        db.run("DELETE FROM kill_dates WHERE status != 'Active'");

        removedPullTasks = db.get(
            "SELECT COUNT(*) as c FROM tasks WHERE task_id LIKE 'AUTO-PULL-%' AND status != 'Open'",
        )?.c ?? 0;
        db.run("DELETE FROM tasks WHERE task_id LIKE 'AUTO-PULL-%' AND status != 'Open'");
    })();

    const activeRemaining = db.get("SELECT COUNT(*) as c FROM kill_dates WHERE status='Active'")?.c ?? 0;
    return { removedKillDates, removedPullTasks, activeRemaining };
}

module.exports = { clearMarkdownArchive };
