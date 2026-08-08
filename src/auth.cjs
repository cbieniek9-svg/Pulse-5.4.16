const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { isTrainingStaff } = require('./lib/training-staff.cjs');
const { isManagerRole } = require('./lib/staff-permissions.cjs');

/** Idle timeout: session expires if no authenticated request for this long. Each `getSession` hit slides `last_active_at`. */
const SESSION_TIMEOUT = 12 * 60 * 60 * 1000; // 12 hours (store shift); mobile keepalive pings every 4 min while visible
/** Sliding the idle clock on every request would write to SQLite on every call; once a minute is precise enough for a 12h window. */
const SESSION_TOUCH_INTERVAL = 60 * 1000;

const PRIVILEGED_TABLES = new Set(['staff', 'rhythm_tasks', 'vendor_schedule', 'settings']);

const auth = (db) => {
    // Tests and older databases may construct auth before migration 046 has run.
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                staff_id INTEGER,
                name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT '',
                training INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                last_active_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active_at);
            CREATE INDEX IF NOT EXISTS idx_sessions_staff_id ON sessions(staff_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);
        `);
    } catch (err) {
        console.warn(`[AUTH] Could not ensure sessions table: ${err.message}`);
    }

    const hasCurrentCredentialAccess = (staff) => (
        !!staff
        && Number(staff.active) === 1
        && Number(staff.app_access) === 1
    );

    const getCredentialAccessStatus = (name) => {
        if (!name || name === 'PC_ADMIN') return { known: false, allowed: false, staff: null };
        const staff = db.findStaffByName(name);
        return {
            known: !!staff,
            allowed: !isTrainingStaff(name)
                && !isTrainingStaff(staff?.name)
                && hasCurrentCredentialAccess(staff),
            staff: staff || null,
        };
    };

    const rowToSession = (row) => ({
        token: row.token,
        staff_id: row.staff_id ?? null,
        name: row.name,
        role: row.role,
        training: row.training === 1,
        lastActive: Date.parse(row.last_active_at) || 0,
    });

    const createSession = (user) => {
        const token = crypto.randomBytes(24).toString('hex');
        const now = new Date().toISOString();
        db.run(
            `INSERT INTO sessions (token, staff_id, name, role, training, created_at, last_active_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            token,
            user.id ?? null,
            user.name,
            user.role ?? '',
            isTrainingStaff(user.name) ? 1 : 0,
            now,
            now,
        );
        return token;
    };

    const destroySession = (token) => {
        if (!token) return false;
        return db.run('DELETE FROM sessions WHERE token = ?', token).changes > 0;
    };

    /** Revoke every session for a staff member — used when a role, active flag, or app access changes. */
    const destroySessionsForStaff = ({ staffId = null, name = null } = {}) => {
        if (staffId == null && !name) return 0;
        if (staffId != null && name) {
            return db.run('DELETE FROM sessions WHERE staff_id = ? OR name = ?', staffId, name).changes;
        }
        if (staffId != null) return db.run('DELETE FROM sessions WHERE staff_id = ?', staffId).changes;
        return db.run('DELETE FROM sessions WHERE name = ?', name).changes;
    };

    const listActiveSessions = () => {
        const cutoff = new Date(Date.now() - SESSION_TIMEOUT).toISOString();
        return db.all('SELECT * FROM sessions WHERE last_active_at > ? ORDER BY last_active_at DESC', cutoff)
            .map(rowToSession);
    };

    const getSession = (token) => {
        if (!token) return null;
        let row;
        try {
            row = db.get('SELECT * FROM sessions WHERE token = ?', token);
        } catch (err) {
            console.warn(`[AUTH] Session lookup failed: ${err.message}`);
            return null;
        }
        if (!row) return null;

        const lastActive = Date.parse(row.last_active_at) || 0;
        if (Date.now() - lastActive > SESSION_TIMEOUT) {
            destroySession(token);
            return null;
        }

        // Roles are re-read from staff on every lookup: a promotion or demotion takes
        // effect immediately instead of lingering until the token times out.
        const staff = row.staff_id != null
            ? db.get('SELECT id, name, role, active, app_access FROM staff WHERE id = ?', row.staff_id)
            : db.get('SELECT id, name, role, active, app_access FROM staff WHERE name = ?', row.name);

        if (!hasCurrentCredentialAccess(staff)) {
            destroySession(token);
            return null;
        }

        if (Date.now() - lastActive > SESSION_TOUCH_INTERVAL) {
            db.run('UPDATE sessions SET last_active_at = ? WHERE token = ?', new Date().toISOString(), token);
        }
        if (staff.role !== row.role || staff.name !== row.name) {
            db.run('UPDATE sessions SET role = ?, name = ? WHERE token = ?', staff.role ?? '', staff.name, token);
        }

        return {
            token,
            staff_id: staff.id,
            name: staff.name,
            role: staff.role ?? '',
            training: row.training === 1,
            lastActive: Date.now(),
        };
    };

    const cleanupSessions = () => {
        const cutoff = new Date(Date.now() - SESSION_TIMEOUT).toISOString();
        try {
            return db.run('DELETE FROM sessions WHERE last_active_at <= ?', cutoff).changes;
        } catch (err) {
            console.warn(`[AUTH] Session cleanup failed: ${err.message}`);
            return 0;
        }
    };

    const getRateLimitStatus = (name) => {
        const attempt = db.get("SELECT * FROM auth_attempts WHERE staff_name = ?", name);
        if (!attempt?.locked_until) return { allowed: true };
        try {
            const raw = attempt.locked_until.includes('T') ? attempt.locked_until : attempt.locked_until.replace(' ', 'T') + 'Z';
            const lockedUntil = new Date(raw);
            if (isNaN(lockedUntil.getTime())) {
                // Malformed date — treat as still locked to be safe, expire after 15 min from first fail
                return { allowed: false, lockedUntil: Date.now() + 15 * 60 * 1000 };
            }
            if (lockedUntil > new Date()) return { allowed: false, lockedUntil: lockedUntil.getTime() };

            // L4 FIX: Lock expired, reset fail count to prevent immediate re-lock on next fail
            db.run("DELETE FROM auth_attempts WHERE staff_name = ?", name);
        } catch (_) {
            return { allowed: false, lockedUntil: Date.now() + 15 * 60 * 1000 };
        }
        return { allowed: true };
    };

    const recordLoginAttempt = (name, success) => {
        if (success) {
            db.run("DELETE FROM auth_attempts WHERE staff_name = ?", name);
            return;
        }
        const now = new Date().toISOString();
        const attempt = db.get("SELECT * FROM auth_attempts WHERE staff_name = ?", name);
        if (!attempt) {
            db.run("INSERT INTO auth_attempts (staff_name, fail_count, first_fail_at) VALUES (?, 1, ?)", name, now);
        } else {
            const newCount = attempt.fail_count + 1;
            let lockedUntil = null;
            if (newCount >= 5) {
                lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
            }
            db.run("UPDATE auth_attempts SET fail_count = ?, locked_until = ? WHERE staff_name = ?", newCount, lockedUntil, name);
        }
    };

    const isAuthorizedSession = (token, requireManager = false) => {
        const session = getSession(token);
        if (!session) return false;
        if (requireManager && !isManagerRole(session.role)) return false;
        return true;
    };

    const isAuthorizedManager = async (userContext) => {
        if (!userContext || !userContext.name || typeof userContext.pin !== 'string') return false;
        if (isTrainingStaff(userContext.name)) {
            recordLoginAttempt(userContext.name, false);
            return false;
        }
        const rateLimit = getRateLimitStatus(userContext.name);
        if (!rateLimit.allowed) return false;

        if (userContext.name === 'PC_ADMIN') {
            const { resolvePcAdminPin } = require('./lib/pc-admin-pin.cjs');
            const resolved = resolvePcAdminPin({ db });
            const adminPin = resolved.pin || '';
            const inputPin = Buffer.from(userContext.pin), targetPin = Buffer.from(adminPin);
            let match = false; if (inputPin.length === targetPin.length) match = crypto.timingSafeEqual(inputPin, targetPin);
            const success = !resolved.disabled && !resolved.insecureDefault && match;
            recordLoginAttempt(userContext.name, success);
            return success;
        }

        const access = getCredentialAccessStatus(userContext.name);
        const user = access.staff;
        if (!access.allowed) {
            recordLoginAttempt(userContext.name, false);
            return false;
        }
        if (!isManagerRole(user.role) || !user.pin) { recordLoginAttempt(userContext.name, false); return false; }

        let match = false;
        if (user.pin_hashed) match = await bcrypt.compare(userContext.pin, user.pin);
        else { 
          match = user.pin === userContext.pin; 
          if (match) { 
            const hash = await bcrypt.hash(userContext.pin, 10); 
            const current = getCredentialAccessStatus(userContext.name);
            if (!current.allowed || !isManagerRole(current.staff?.role)) {
              recordLoginAttempt(userContext.name, false);
              return false;
            }
            db.transaction(() => {
              db.run("UPDATE staff SET pin = ?, pin_hashed = 1 WHERE name = ?", hash, user.name);
            })();
          } 
        }

        if (match && user.pin_hashed) {
          const current = getCredentialAccessStatus(userContext.name);
          match = current.allowed && isManagerRole(current.staff?.role);
        }
        recordLoginAttempt(userContext.name, match); return match;
    };

    const resolveActionActor = async ({ token, userContext, table, action, data }) => {
      const effectiveToken = token || userContext?.token;
      if (effectiveToken) {
        const session = getSession(effectiveToken);
        if (session) return session.name;
      }

      const access = getCredentialAccessStatus(userContext?.name);
      if (access.known && !access.allowed) {
        const error = new Error('Account access is revoked.');
        error.status = 403;
        error.code = 'ACCOUNT_ACCESS_REVOKED';
        throw error;
      }
      
      if (await isAuthorizedManager(userContext)) return userContext.name;
      if (!userContext || !userContext.name) return null;

      // H1 FIX: Do not allow known-staff fallback for privileged tables (staff, rhythm, settings)
      if (PRIVILEGED_TABLES.has(table)) return null;

      return null;
    };

    function migrateStaffPins() {
      const staffToMigrate = db.all("SELECT id, name, pin, pin_hashed FROM staff WHERE pin IS NOT NULL AND pin != ''");
      if (staffToMigrate.length === 0) return;
      
      db.transaction(() => {
        for (const s of staffToMigrate) {
          if (s.pin_hashed === 1) {
            const looksHashed = /^\$2[aby]\$\d\d\$/.test(s.pin) && s.pin.length >= 55;
            if (!looksHashed) {
              // L3 FIX: Log when a malformed hash is cleared
              console.warn(`[SECURITY] Clearing malformed hash for staff ID ${s.id} (${s.name})`);
              db.run("UPDATE staff SET pin = '', pin_hashed = 0 WHERE id = ?", s.id);
            }
            continue;
          }
          const looksHashed = /^\$2[aby]\$\d\d\$/.test(s.pin) && s.pin.length >= 55;
          if (looksHashed) {
            db.run("UPDATE staff SET pin_hashed = 1 WHERE id = ?", s.id);
            continue;
          }
          const hash = bcrypt.hashSync(s.pin, 10);
          db.run("UPDATE staff SET pin = ?, pin_hashed = 1 WHERE id = ?", hash, s.id);
        }
      })();
    }

    return {
        createSession,
        getSession,
        destroySession,
        destroySessionsForStaff,
        listActiveSessions,
        cleanupSessions,
        getRateLimitStatus,
        recordLoginAttempt,
        getCredentialAccessStatus,
        isAuthorizedSession,
        isAuthorizedManager,
        resolveActionActor,
        migrateStaffPins,
    };
};

module.exports = auth;
