'use strict';

/**
 * Chaos monkey findings collector — never throws for assertion failures.
 */
class ChaosReport {
    constructor() {
        this.startedAt = new Date().toISOString();
        this.base = process.env.TGP_BASE_URL || 'http://127.0.0.1:3001';
        this.findings = [];
        this.meta = {};
    }

    pass(phase, id, detail = '') {
        this.findings.push({ phase, id, status: 'pass', detail: String(detail || ''), at: new Date().toISOString() });
        console.log(`  OK  [${phase}] ${id}${detail ? ` — ${detail}` : ''}`);
    }

    fail(phase, id, detail = '') {
        this.findings.push({ phase, id, status: 'fail', detail: String(detail || ''), at: new Date().toISOString() });
        console.error(` FAIL [${phase}] ${id} — ${detail}`);
    }

    skip(phase, id, detail = '') {
        this.findings.push({ phase, id, status: 'skip', detail: String(detail || ''), at: new Date().toISOString() });
        console.log(` SKIP [${phase}] ${id}${detail ? ` — ${detail}` : ''}`);
    }

    async check(phase, id, fn) {
        try {
            const detail = await fn();
            this.pass(phase, id, detail === undefined ? '' : detail);
            return true;
        } catch (e) {
            this.fail(phase, id, e?.message || String(e));
            return false;
        }
    }

    summary() {
        const passed = this.findings.filter((f) => f.status === 'pass').length;
        const failed = this.findings.filter((f) => f.status === 'fail').length;
        const skipped = this.findings.filter((f) => f.status === 'skip').length;
        return { passed, failed, skipped, total: this.findings.length };
    }

    toJSON() {
        return {
            startedAt: this.startedAt,
            finishedAt: new Date().toISOString(),
            base: this.base,
            meta: this.meta,
            summary: this.summary(),
            findings: this.findings,
            failures: this.findings.filter((f) => f.status === 'fail'),
        };
    }
}

module.exports = { ChaosReport };
