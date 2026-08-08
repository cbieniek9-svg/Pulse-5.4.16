---
title: "Security & Reliability Review"
product: TGP Command Center
version: "5.3.1"
date: 2026-07-27
audience: programmer peer review
scope: resources/app
---

# TGP Command Center — Security & Reliability Peer Review

Threat model is **trusted store LAN**, not internet. Even so, guest Wi‑Fi, phone malware, and “anyone on 192.168” are real. No sugarcoating.

---

## Critical

### 1. CS CRM / CS_Full APIs are feature-gated only — no session
**Evidence:** `src/routes/betacs.cjs` — `/api/cs/customers`, create/update, phone lookup, `/api/cs/due-orders`, `/api/betacs/orders`, print slip all check `isCsFullEnabled` / CRM flags only; **zero** `requireSession`.

```85:120:C:\Users\SMS\Desktop\TGPV5\TGP_V5\resources\app\src\routes\betacs.cjs
    server.get('/api/cs/customers', wrap(async (req, res) => {
        if (!assertCrm(res)) return;
        // ... returns customer PII
    }));
    server.post('/api/cs/customers', wrap(async (req, res) => {
        if (!assertCrm(res)) return;
        // ... creates customers — no auth
```

**Blast radius:** Full customer name/phone CRM R/W + open order lists for anyone on LAN when CS_Full/CRM is on.  
**Fix direction:** Require live staff/manager session (or device token + role) on every mutating and PII-read route; keep `/api/cs/config` public if needed.

---

### 2. `CS_DESK` is PIN-less write access to `special_orders`
**Evidence:** Documented intentional kiosk actor:

```242:257:C:\Users\SMS\Desktop\TGPV5\TGP_V5\resources\app\src\auth.cjs
      // Intentional store-LAN kiosk actors (no PIN). Trusted Wi‑Fi only — any client on
      // the LAN can claim these names. CS_DESK is live; ...
      if (userContext.name === CS_DESK_ACTOR && table === 'special_orders' && ['insert', 'update'].includes(action)) return CS_DESK_ACTOR;
```

Tests encode empty PIN (`tests/betacs-portal-api.test.cjs`, Playwright). Same pattern for `RECEIVING_STATION` / `MARKDOWN_STATION`.

**Blast radius:** Forge/alter/close customer orders from any LAN client; audit attributes `CS_DESK`.  
**Fix direction:** Bind CS desk to device token (or session); reject bare `userContext.name` spoof. Comment already says this.

---

### 3. Tokenless LAN default → TV audience gets full floor sync, including `orders` with PII
**Evidence:** Default tokenless (`src/lib/poc-access.cjs:47-51`, tested in `tests/tokenless-store-mode.test.cjs`). Sync promotes unauthorized clients to `role: 'TV'` (`src/dal/sync-payload.cjs:106-114`). TV path still ships `orders: getMobileCustomerOrders(db)` which is `SELECT *` (`special-orders.cjs:84-92`), not the redacted `orders_tv`.

Also `/api/stream` falls open under tokenless when `st` is missing/expired (`app-boot.cjs:269-275`).

**Blast radius:** Guest-on-Wi‑Fi reads open tasks, OOS, shrink $, kill dates, **full customer orders**, SSE.  
**Fix direction:** Default `Require_TV_Device_Token=1` for production; TV payload must use only `orders_tv`; never grant TV audience full `orders`; require stream token or device token even in PoC.

---

## High

### 4. “Secure this store” still allows IP fallback
**Evidence:** `findAuthorizedTrustedDevice(..., { allowIpFallback: true })` everywhere (`app-boot.cjs:257,273,312`, `sync-payload.cjs:107`). Token required only blocks *anonymous* tokenless; Authorized row matched by IP still works without token.

**Blast radius:** DHCP renumber / IP spoof → TV as authorized display; readiness warns about missing hashes but does not enforce tokens.  
**Fix direction:** When `Require_TV_Device_Token=1`, set `allowIpFallback: false` (or only allow IP for Pending discovery, not Authorized sync/TV HTML).

---

### 5. PC_ADMIN falls back to `1234` on upgrades; deleting last manager re-opens bootstrap
**Evidence:** Priority chain in `pc-admin-pin.cjs:24-93`; `LEGACY_DEFAULT_PIN = '1234'`. `isAuthorizedManager` enables PC_ADMIN only when no Manager exists (`auth.cjs:193-201`). Fresh installs mint a file; upgrades with managers still resolve legacy PIN for the dormant bootstrap.

**Blast radius:** Wipe/demote last manager → LAN login as PC_ADMIN with `1234` until env/file set.  
**Fix direction:** Never return `1234`; if bootstrap needed and no file/env, mint file or refuse login. Block PC_ADMIN until `pc-admin-pin.txt` / env exists.

---

### 6. EOD catch-up skips order-history archive on intermediate days
**Evidence:** `catchUpMissedSweeps` sets `skipOrderHistoryArchive: dayToSweep !== todayStr` (`app-boot.cjs:511-513`). Mutex drops overlaps with `{ skipped: true, reason: 'busy' }` (`api.cjs:112-115`) and catch-up **breaks** without advancing (good), but busy scheduled vacuum EOD can be silently lost.

**Blast radius:** Multi-day outage → unfinished clocks not archived for missed days; scorecard/FINISH history gaps; one dropped EOD = no vacuum that night.  
**Fix direction:** Queue/retry busy sweeps; consider archive-on-catch-up for days that had a live clock; alert when catch-up pauses.

---

### 7. WinSW live XML is machine-absolute (Desktop path) — copy kills production
**Evidence:** Live `service/TGP-CommandCenter.xml` points at `C:\Users\SMS\Desktop\TGPV5\...`; template uses placeholders (`TGP-CommandCenter.xml.template`). `scripts/verify-store-deploy.cjs` already fails mismatched paths.

**Blast radius:** Copy XML to another PC → service points at wrong tree / dead Electron; silent wrong `TGP_DATA_DIR`.  
**Fix direction:** Never ship live XML in deploy packages; install script only; fail boot if paths ≠ appRoot.

---

### 8. Session tokens stored plaintext in SQLite (046)
**Evidence:** `sessions.token TEXT PRIMARY KEY` (`046_persistent_sessions.cjs`, `auth.cjs:17-25`). Persistence survived restarts (good for floor UX) but DB/backup theft = every live session.

**Blast radius:** Backup share, malware on store PC, copied `*.db` → impersonate staff/managers until idle timeout (12h sliding).  
**Fix direction:** Store `sha256(token)` only; compare hash on lookup; rotate on privilege changes (already destroy on revoke).

---

## Medium

### 9. Financial Log “shadow mode” is soft — any manager can disable/rewrite allowlist
**Evidence:** Gates use `canAccessFinancialLog` (`receiving-helpers.cjs:47-59`). Default shadow on (`044_financial_log_shadow.cjs`). But `PUT /api/receiving/report/shadow/settings` is `requireManagerOnly` — any manager sets `shadow_mode: false` or allowlist (`receiving-report.cjs:107-145`).

**Blast radius:** Pilot exclusivity is policy, not enforcement; first claim wins until another manager edits settings.  
**Fix direction:** Restrict settings to Store Manager / allowlist owner; or env-locked shadow until deliberately opened.

---

### 10. `requireSession` vs `/api/action` token source inconsistency
**Evidence:**
- `requireSession`: header **then** body (`api.cjs:57-58`)
- `/api/action`: body `token` / `userContext.token` **then** header (`action.cjs:36-37`)
- Settings ACL uses **body `token` only**, not `effectiveToken`/`headerToken` (`action.cjs:107` → `checkSettingPermission` with `token`)

**Blast radius:** Header-only clients fail settings writes; body can override header session (confused-deputy if XSS plants body token). Maintenance daily-rhythm still accepts PIN-only manager fallback (`maintenance.cjs:35-41`).  
**Fix direction:** Single resolver: prefer header, ignore conflicting body; always pass `effectiveToken` into settings checks; rate-limit PIN fallbacks.

---

### 11. CORS allows `null` origin; LAN bind defaults open
**Evidence:** `isAllowedCorsOrigin`: `if (!origin || origin === 'null') return true` (`network-config.cjs:109-110`). `Allow_LAN_Clients` defaults true → `0.0.0.0` (`buildNetworkConfig`).

**Blast radius:** `file://` / sandboxed null-origin browsers on LAN can call API (still need tokens for most writes — except Critical #1–3).  
**Fix direction:** Reject `null` unless explicit PoC flag; document that default bind is intentional.

---

### 12. Attach-or-serve ignores `restart_required`
**Evidence:** `probeLocalApiReady` only checks `j.ok === true` (`app-boot.cjs:60-63`). `/api/ready` correctly sets `restart_required` from deploy fidelity (`app-boot.cjs:170-177`, `deploy-fidelity.cjs:75-88`). Electron attaches UI-only to stale service after file copy (`main.cjs:64-80`).

**Blast radius:** UI looks “updated”; API/process still old until WinSW restart — classic skew.  
**Fix direction:** Surface `restart_required` in Electron dialog; refuse quiet attach when true.

---

### 13. Order FINISH accepts client `order_end`
**Evidence:** `ops.cjs:50-55` parses client `order_end`; archive uses it (`order-finish.cjs`). Auth is shift-lead+ (good). Clock clamp on end&lt;start avoids stuck clock (good reliability).

**Blast radius:** Shift lead can backdate duration → PPH/scorecard distortion.  
**Fix direction:** Server-now by default; allow override only with manager + audit reason.

---

### 14. Rate limits are coarse
**Evidence:** Global `/api/` 200/min (`app-boot.cjs:189-195`); `/api/mobile-auth` 5/15min. Per-name lockout in `auth_attempts` (good). No trust-proxy config visible — IP keying OK on flat LAN, wrong behind reverse proxy.

**Blast radius:** Busy floors + sync polling can 429; auth spray across names still limited by IP bucket.  
**Fix direction:** Raise/sync-exempt authenticated GETs; document no reverse proxy without `trust proxy`.

---

## Low

### 15. Public `/api/sync` and CS login lists leak staff roster/roles/permissions
Public early-return maps `loginStaffRow` with role + permissions (`sync-payload.cjs:248-277`). `/api/cs/login-staff`, `/api/betacs/taken-by` unauthenticated name lists.

### 16. `/api/ready` unauthenticated info disclosure
Version, deploy fingerprint, LAN addresses, HTTPS ports — useful for ops, also for LAN recon.

### 17. Training PIN constant `1234` when training mode on
Known demo credential (`training-staff.cjs`); redacted from public sync (Playwright P1) but managers get pin in sync payload.

### 18. UncaughtException logged, process continues (`app-boot.cjs:150-155`)
Corrupt-in-memory risk after fatal errors.

---

## What’s in decent shape

| Area | Notes |
|------|--------|
| Persistent sessions (046) | Survive restart; role refresh; revoke on deactivate; logout destroys server-side (`core.cjs:117-131`) |
| Rhythm deferral fail-closed | Seed aborts; completeness returns empty + `deferral_lookup_failed` (`daily-rhythm.cjs:154-167,364-367`) |
| Store-local ISO / heal | Covered by `daily-rhythm.test.cjs`, `store-time` tests |
| Order-finish archive path | Transactional; upserts history; clears clock; shift-lead gated |
| EOD same-day idempotency + snapshot fail-closed | Won’t destroy without snapshot (`api.cjs:181-187`); Last_EOD upsert fix documented |
| Presence ingest | Gateway key required (`presence.cjs:23-28`) |
| Sensitive settings redaction | `SENSITIVE_SETTING_KEYS` + Playwright P1 |
| Deploy fidelity | Boot fingerprint + `/api/ready.restart_required` + unit tests |
| PC_ADMIN env/file mint | Fresh path is solid; upgrade legacy is the problem |

---

## Tests — coverage vs holes

**node:test (via `npm run test:unit` / Electron ABI) covers well:**
- Auth persistence & revoke (`auth-sessions.test.cjs`)
- Rhythm ensure/heal/deferral/store-local (`daily-rhythm.test.cjs`, `rhythm-deferrals.test.cjs`, `rhythm-eod-chaos.test.cjs`)
- Order finish / archive health, deploy fidelity, network-config, pc-admin resolve, tokenless policy unit, production-readiness, many domain libs

**Holes:**
| Gap | Why it matters |
|-----|----------------|
| No test that CS CRM routes require auth | Critical #1 ships green |
| CS_DESK empty-PIN is **fixture**, not attacker case | Critical #2 normalized |
| Tokenless sync must not include full `orders` | Unasserted |
| Body vs header token / settings ACL | Unasserted |
| Shadow settings bypass by second manager | Unasserted |
| Playwright `security_audit.spec.js` | Only H1 staff, health, CSV injection, public redact, query-token — thin |
| React UI | No component/unit suite; `ui-shell.test.cjs` is string/static; Playwright portals are smoke |
| Live integration | `betacs-portal-api` needs running server; not in unit runner |
| EOD busy drop / catch-up archive skip | Logic exists; limited adversarial coverage |

---

## Priority fix order

1. Auth-wrap all CS CRM/PII routes; strip full `orders` from TV/tokenless sync.  
2. Kill PIN-less `CS_DESK` (and siblings) unless device-bound.  
3. Default-off tokenless; enforce no IP fallback when tokens required.  
4. Eliminate PC_ADMIN `1234`; mint or refuse.  
5. Hash session tokens at rest; fix token resolution consistency.  
6. Harden WinSW packaging + Electron `restart_required` UX.  
7. Add security tests that fail the build for #1–3.

I did not write or change any files.
