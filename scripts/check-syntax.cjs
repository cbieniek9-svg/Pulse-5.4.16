#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');

const DEFAULT_FILES = [
    'main.cjs',
    'src/db.cjs',
    'src/api.cjs',
    'src/lib/backup-health.cjs',
    'src/lib/db-health.cjs',
    'src/lib/migration-safety.cjs',
    'src/lib/release-manifest.cjs',
    'src/lib/production-readiness.cjs',
    'src/lib/poc-access.cjs',
    'src/lib/pc-admin-pin.cjs',
    'src/lib/store-instance-id.cjs',
    'src/migrations/018_long_term_history_snapshots.cjs',
    'src/migrations/019_receiving_vendor_work_tasks.cjs',
    'src/migrations/020_daily_safety_blurbs.cjs',
    'src/migrations/021_receiving_file_maintenance_log.cjs',
    'src/migrations/022_receiving_vendor_cleanup.cjs',
    'src/migrations/023_staff_schedule_aliases.cjs',
    'src/migrations/024_tv_display_toggles.cjs',
    'src/migrations/025_tv_display_stabilization.cjs',
    'src/migrations/029_store_instance_id.cjs',
    'src/lib/receiving-flow.cjs',
    'src/lib/vendor-canonical.cjs',
    'src/lib/staff-name-aliases.cjs',
    'src/lib/rhythm-schedule-assign.cjs',
    'src/lib/schedule-health.cjs',
    'src/lib/shift-lead.cjs',
    'src/lib/file-maintenance-receiving-log.cjs',
    'src/lib/history-export.cjs',
    'src/lib/history-trends.cjs',
    'src/lib/daily-direction.cjs',
    'src/lib/safety-blurbs.cjs',
    'src/dal/reports-payload.cjs',
    'src/routes/manager/maintenance.cjs',
    'src/routes/manager/audits.cjs',
    'src/routes/manager/safety.cjs',
    'src/constants/api-settings.cjs',
    'src/routes/reports.cjs',
    'scripts/verify-backup.cjs',
    'scripts/fresh-install-smoke.cjs',
    'scripts/upgrade-smoke.cjs',
    'scripts/verify-release.cjs',
    'src/actions/handlers.cjs',
    'public/tv/tv-dashboard.js',
];

function checkFiles(files = DEFAULT_FILES) {
    const results = files.map((file) => {
        const res = spawnSync(process.execPath, ['--check', file], {
            cwd: appRoot,
            encoding: 'utf8',
            windowsHide: true,
        });
        return {
            file,
            ok: res.status === 0,
            status: res.status,
            stdout: (res.stdout || '').trim(),
            stderr: (res.stderr || '').trim(),
        };
    });
    return {
        ok: results.every((r) => r.ok),
        results,
    };
}

if (require.main === module) {
    const json = process.argv.includes('--json');
    const files = process.argv.filter((a) => !a.startsWith('--')).slice(2);
    const result = checkFiles(files.length ? files : DEFAULT_FILES);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
        result.results.forEach((r) => {
            console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.file}`);
            if (!r.ok) console.error(r.stderr || r.stdout || `exit ${r.status}`);
        });
    }
    process.exit(result.ok ? 0 : 1);
}

module.exports = { DEFAULT_FILES, checkFiles };
