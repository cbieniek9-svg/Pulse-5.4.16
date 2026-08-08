---
title: "Peer Review Deep Dive"
product: TGP Command Center
version: "5.3.1"
date: 2026-07-27
audience: programmer peer review
scope: resources/app
---

# TGP Command Center — Peer Review Deep Dive

Programmer-facing architecture + security/reliability synthesis of live tree `resources/app`.

**Version:** 5.3.1 · **Date:** 2026-07-27 · **Live probe:** ok · restart_required=false · HTTPS :3443 · LAN 10.103.0.139

**Size:** ~32.6k src · ~22.6k client/src · 46 migrations · 134 test files under `tests/`

Related exports:

- [01-architecture-module-map.md](./01-architecture-module-map.md)
- [02-security-reliability-review.md](./02-security-reliability-review.md)

---

## Verdict

Overall **7.4 / 10** for store-LAN ops maturity; mornings ~**9**; auth/LAN trust ~**4–5** if you treat guest Wi‑Fi as hostile.

This is a mature single-store LAN ops system with unusually strong morning/EOD honesty after recent hardening waves — and an intentional “trusted Wi‑Fi” auth posture that is unsafe if you model guest VLAN or walk-up devices as adversaries. Do not conflate “works at the store” with “authZ is sound.” Ranked Critical items are design debt with production blast radius, not theoretical CVEs behind NAT.

| Metric | Value |
|--------|------:|
| Overall (peer) | 7.4 |
| Mornings / rhythm | ~9 |
| Auth / LAN | 4.5 |
| Critical findings | 3 |

---

## Maturity scorecard

| Area | Score | Notes |
|------|------:|-------|
| Process / deploy | 8 | WinSW + Electron-as-Node + deploy-fidelity + restart banner. ABI lock-in remains. |
| Morning rhythm / EOD | 9 | Fail-closed deferrals, completeness v2, EOD mutex + snapshot abort. Catch-up archive skips are the residual. |
| Floor React ownership | 8.5 | Rule + 301s + orphan quarantine. FINISH gate / DD Shift Update on React. |
| Sync / SSE contract | 7.5 | Audience model solid; KEY_MAP gaps force full sync; GET /api/sync mutates. |
| Receiving dock | 8 | Staff-only dock payloads; separate from Financial Log by design. |
| Daily Direction | 7 | React UX fixed; dual writers (update-posted vs shift-update) still dual APIs. |
| Auth / LAN boundary | 4.5 | Trusted-Wi-Fi PoC posture. CS CRM unauth + CS_DESK spoof + tokenless full orders are real. |
| Financial Log | 6 | Shadow by design; any manager can flip settings. |
| TV wall | 6 | Intentional legacy; tokenless path overshares vs orders_tv. |
| Tests / CI net | 7 | Strong unit/domain; Playwright security_audit misses CS/CRM/tokenless PII. |
| Code health / god modules | 6 | daily-direction ~1.7k; Edmonton stack; handlers.cjs chokepoint. |

---

## Architecture summary

| Layer | Contract |
|-------|----------|
| Host | WinSW → electron.exe + ELECTRON_RUN_AS_NODE=1 → server.cjs; OR Electron main.cjs attach-or-serve |
| Boot | app-boot.startAppServer: db require (migrations) → Express → apiFactory → schedulers → EOD catch-up → optional HTTPS |
| Data | better-sqlite3 WAL, busy_timeout 5000, sync NORMAL; paths via TGP_DATA_DIR; Pulse secondary DB |
| Mutations | POST /api/action → validateAction → resolveActionActor → handlers.cjs; plus manager/* specialized routes |
| Read model | GET /api/sync assembleSyncPayload by audience public/staff/manager/tv; SSE DELTA/REFRESH |
| UI | Vite React dist/ui for floor+portals; SyncProvider only on FloorLayout; TV = public/tv legacy |

### Dualism inventory

| Surface | Live SoT | Orphan / twin | Status |
|---------|----------|---------------|--------|
| Floor | client/src → dist/ui | mobile.html + public/js/mobile/* | Orphan; 301 /mobile.html → / |
| Settings | React /settings | mgr-settings.html + public/js/mgr-settings.js | Orphan; 301 |
| Reports UI | client/src/reports/sections/* | bundled.js + public/js/reports/* | Orphan twins |
| TV | public/tv/* | (no React yet) | Allowed legacy |
| Sync delta | client syncReducer.js | public/js/mobile/stream.js KEY_MAP | Twin; React owns floor |

### God modules (blast radius)

| ~LOC | File | Owns |
|-----:|------|------|
| ~1728 | src/lib/daily-direction.cjs | DD / shift updates / floor views / broadcasts |
| ~1103 | src/lib/edmonton-receiving-analytics.cjs | Financial analytics |
| ~992 | src/routes/manager/receiving-report.cjs | Financial HTTP |
| ~846 | src/dal/reports-payload.cjs | Reports assemble |
| ~729 | src/actions/handlers.cjs | /api/action mutation god |
| ~547 | src/lib/app-boot.cjs | Process + HTTP shell |
| ~453 | src/lib/daily-rhythm.cjs | Morning ensure/heal |
| ~2277 | client/.../bundled.js | ORPHAN reports twin — do not edit for live |
| ~1156 | client/src/cs/CsApp.jsx | CS portal |
| ~803 | client/src/log/LogApp.jsx | Financial Log UI |

---

## Ranked findings

Severity = blast radius on a store LAN where feature flags are on. Trusted-Wi-Fi is the threat model the code comments claim; guest Wi‑Fi / walk-up is the model these Crits assume.

### Summary table

| ID | Sev | Title | Where |
|----|-----|-------|-------|
| C1 | Critical | CS CRM / CS_Full HTTP surface is feature-flag gated, not session gated | src/routes/betacs.cjs — assertCrm / isCsFullEnabled only |
| C2 | Critical | CS_DESK (and station actors) are claimable without PIN | src/auth.cjs resolveActionActor ~242–257 |
| C3 | Critical | Tokenless LAN default promotes TV sync to full authenticated payload including full orders | poc-access.cjs · sync-payload.cjs · app-boot stream |
| H1 | High | Require-token mode still allows IP fallback | trusted-device-tokens.cjs; allowIpFallback: true |
| H2 | High | Session token resolution inconsistent (header vs body); settings ACL uses body token only | api.cjs; routes/action.cjs |
| H3 | High | EOD mutex drops overlapping work; catch-up skips order-history archive for intermediate days | api.cjs; app-boot catchUpMissedSweeps |
| H4 | High | PC_ADMIN legacy PIN 1234 on upgrade / last-manager wipe path | pc-admin-pin.cjs; auth |
| H5 | High | Electron attach ignores restart_required; WinSW XML may be absolute Desktop paths | deploy-fidelity; main.cjs; TGP-CommandCenter.xml |
| H6 | High | Session tokens stored plaintext in SQLite (046) | 046_persistent_sessions; auth.cjs |
| M1 | Medium | Financial Log shadow soft — any manager can exit / rewrite allowlist | edmonton-receiving-shadow; receiving-report |
| M2 | Medium | GET /api/sync is not read-only — morning heal + kill-date pull tasks | routes/sync.cjs; daily-rhythm |
| M3 | Medium | SSE KEY_MAP incomplete — chatty full sync; composites never patched | syncReducer.js |
| M4 | Medium | Daily Direction dual writers | daily-direction.cjs; DailyDirectionPanel.jsx |
| M5 | Medium | CORS allows missing/null origin; LAN bind defaults open | network-config.cjs |
| M6 | Medium | Order FINISH accepts client-supplied order_end | ops.cjs; order-finish.cjs |
| L1 | Low | Public sync leaks login roster roles/permissions | sync-payload public branch |
| L2 | Low | Unauthenticated /api/ready leaks version, deploy, LAN, HTTPS URL | app-boot /api/ready |

### C1 — CS CRM unauthenticated

- **Where:** `src/routes/betacs.cjs` — `assertCrm` / `isCsFullEnabled` only
- **Evidence:** GET/POST `/api/cs/customers*`, customer-by-phone, due-orders, betacs orders, print: no `requireSession`. `assertCrm` returns 403 only when CS_Full/CRM settings are off.
- **Blast:** Any host on the store LAN can read/write customer PII and open orders when CS_Full is enabled.
- **Fix:** `requireSession` (staff or device-bound) on every PII/mutate route; keep feature flag as second gate.
- **Test gap:** Playwright `security_audit.spec.js` does not cover unauth CRM. `betacs-portal-api` uses CS_DESK fixture as happy path.

### C2 — CS_DESK PIN-less actor spoof

- **Where:** `src/auth.cjs` `resolveActionActor` ~242–257
- **Evidence:** If `userContext.name === 'CS_DESK'` and table `special_orders` and action in insert|update → actor CS_DESK. Comment admits any LAN client can claim the name. `RECEIVING_STATION` / `MARKDOWN_STATION` similar.
- **Blast:** Forge/alter/close customer orders; audit trail attributes CS_DESK.
- **Fix:** Bind desk to device token or real session; reject bare-name spoof.
- **Test gap:** Empty-PIN CS is a fixture, not an attacker case.

### C3 — Tokenless TV sync overshares full orders

- **Where:** `poc-access.cjs` · `sync-payload.cjs` · app-boot stream
- **Evidence:** Tokenless defaults ON. Sync builds `role:TV` via `buildTokenlessDeviceSession`. Authenticated body includes `orders: getMobileCustomerOrders` (SELECT *) **and** `orders_tv`.
- **Blast:** Guest Wi‑Fi can pull tasks, OOS, shrink, kill dates, and customer contact on special_orders.
- **Fix:** Default `Require_TV_Device_Token=1`; TV audience must omit full `orders`; require stream/device token even in PoC.
- **Test gap:** `tokenless-store-mode.test.cjs` asserts policy default; does not assert orders omission.

### High

**H1 — IP fallback with tokens required.** Callers always pass `allowIpFallback: true`. Token-required only disables anonymous tokenless. Fix: when tokens required, `allowIpFallback: false`.

**H2 — Token header/body inconsistency.** `requireSession`: header then body. `/api/action`: body first then header. Settings ACL uses body token only. Fix: single resolver prefer header; pass `effectiveToken` into ACL.

**H3 — EOD busy drop / catch-up archive skip.** Overlap returns `{ skipped: true, reason: busy }`. Catch-up uses `skipOrderHistoryArchive` for intermediate days. Fix: queue/retry; archive catch-up days that had a live clock.

**H4 — PC_ADMIN legacy 1234.** Used when no Manager remains. Fix: never return `1234`; mint or refuse bootstrap.

**H5 — Deploy attach ignores restart_required.** `probeLocalApiReady` checks `ok === true` only. Live WinSW XML may be absolute Desktop paths. Fix: refuse/warn attach when `restart_required`; ship template only.

**H6 — Session tokens plaintext at rest.** `sessions.token` stores bearer as-is. Fix: store `sha256(token)` only.

### Medium

**M1 — Financial shadow soft ACL.** Any manager can PUT shadow settings. Fix: lock to Store Manager / allowlist owner or env-lock.

**M2 — GET /api/sync mutates.** Morning heal + kill-date pull tasks. Fix: move heal to scheduler/POST; document side effects.

**M3 — SSE KEY_MAP gaps.** `comms_messages` urgent but unmapped; dock/transfer/incident force full sync. Fix: add mappers or stop marking urgent; edit React reducer only.

**M4 — DD dual writers.** `update-posted` vs shift-update/post remain two APIs. Fix: unify service fn with mode `full | message_only`.

**M5 — CORS null + open LAN bind.** Null origin allowed; `Allow_LAN_Clients` defaults true. Fix: reject null unless PoC flag.

**M6 — FINISH client order_end.** Shift-lead gated but client can backdate duration. Fix: server-now by default; manager override + audit.

### Low

**L1 / L2 —** Public sync login roster roles/permissions; unauth `/api/ready` version/deploy/LAN disclosure. Acceptable ops tradeoffs on trusted LAN; optional harden.

---

## Auth surface map

| Mechanism | Where | Peer note |
|-----------|-------|-----------|
| PIN sessions (046) | auth.cjs + sessions table | 12h idle; role re-read; plaintext token in SQLite; bcrypt pins |
| requireSession | api.cjs | header then body; 401 if token present but dead; 403 if absent |
| /api/action token | routes/action.cjs | body/userContext first, then header — differs from requireSession |
| CS_DESK / stations | resolveActionActor | Intentional PIN-less on LAN — Critical if guest Wi‑Fi |
| Device tokens | trusted-device-tokens.cjs | SHA-256 hash at rest; IP fallback still on when “secure” |
| Tokenless PoC | poc-access.cjs | Default ON; production readiness warns |
| CS CRM HTTP | betacs.cjs | Feature flag only — Critical |
| Financial shadow | edmonton-receiving-shadow.cjs | Default on; manager can disable |

---

## What is in decent shape

| Area | Why it holds |
|------|--------------|
| Persistent sessions (046) | Survive restart; role refresh; revoke on deactivate; logout destroys server-side |
| Rhythm deferral fail-closed | Seed aborts; completeness empty + deferral_lookup_failed |
| Order-finish archive | Transactional; history upsert; clock clear; shift-lead gated |
| EOD same-day + snapshot abort | Idempotent Last_EOD; will not destroy without snapshot |
| Presence ingest | Gateway key required |
| Settings redaction | SENSITIVE_SETTING_KEYS + Playwright P1 |
| Deploy fidelity | Boot fingerprint + /api/ready.restart_required + unit tests |
| PC_ADMIN mint (fresh) | Env/file path solid — upgrade legacy 1234 is the hole |

---

## Test / CI coverage vs holes

| Suite | Covers well | Hole |
|-------|-------------|------|
| auth-sessions | 046 persistence / revoke | body vs header ACL |
| tokenless-store-mode | default policy | TV orders PII omission |
| daily-rhythm + deferrals | completeness v2, fail-closed JSON | concurrent heal races |
| deploy-fidelity | version/ui mismatch flags | Electron attach + restart_required |
| pc-admin-pin | documents legacy 1234 | last-manager wipe exploit |
| security_audit (PW) | H1 staff, health, CSV, public redact | CS CRM unauth, CS_DESK spoof, tokenless PII |
| sync-reducer | force-full smoke | KEY_MAP coverage matrix |
| Playwright floor | thin / smoke scripts exist | FINISH gate, DD Shift Update, restart banner |

---

## Recommended fix order

1. Auth-wrap CS CRM/PII routes; strip full orders from TV/tokenless sync
2. Device-bind or session-bind CS_DESK; stop bare-name spoof
3. Production default `Require_TV_Device_Token=1`; disable IP fallback when tokens required
4. Unify token resolver; kill PC_ADMIN 1234; hash sessions at rest
5. EOD busy queue + catch-up archive; attach respects `restart_required`; WinSW template-only
6. Harden Financial shadow ACL; reject CORS null; optional DD unify / FINISH server-now
7. CI security tests that fail on C1–C3

---

## Explicit non-goals / do-nots

- Patch orphan `mobile.html` / `public/js/mobile` / `bundled.js` for live features
- Exit Financial shadow or flip tokenless off without an explicit store ask
- Remote Windows service restart API without a hard auth design
- Treat trusted-Wi-Fi PoC as “secure against guest VLAN” — it is not
- Add React TV until mornings stay boring for a week and C1–C3 are decided

---

## Where to change X

| Goal | Start |
|------|-------|
| Boot / static / SSE / TV route | `src/lib/app-boot.cjs` |
| New HTTP API | `src/routes/*` + `api.cjs` / `manager/index.cjs` |
| Sync fields by audience | `src/dal/sync-payload.cjs` + client `syncReducer.js` |
| Floor mutation | `src/actions/handlers.cjs` + `client/src/lib/floorActions.js` |
| Schema | `src/migrations/0NN_*.cjs` |
| UI route | `client/src/App.jsx` + app-boot `reactPortalPaths` |
| Service install | `service/TGP-CommandCenter.xml.template` + Install script |
| Morning rhythm | `src/lib/daily-rhythm.cjs` + `store-time.cjs` |
| Auth actors | `src/auth.cjs` `resolveActionActor` |

---

*Artifact for programmer peer review — prefer arguing with findings over score aesthetics.*
