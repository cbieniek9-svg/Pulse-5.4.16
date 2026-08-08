# Pulse — internal product name

**Pulse** is the technical (internal) name for TGP’s store operations platform. Staff and customer-facing surfaces keep **TGP** branding (e.g. TGP Centre Store, Receiving Uplink). Use **Pulse** in development, architecture docs, tickets, commits, and agent conversations.

## One-line definition

Pulse is the live store-ops stack: task board, daily rhythm, receiving, order-day metrics, manager reports, and EOD lifecycle — deployed per store on local SQLite + Electron/server runtime.

## Naming convention

| Layer | Name |
|-------|------|
| Staff / customer UI | **TGP Centre Store**, **Receiving**, **Reports**, **TV display** (unchanged) |
| Internal product | **Pulse** |
| When ambiguous (backups, repos, multi-tool docs) | **TGP Pulse** |
| Version labels (internal) | **Pulse 5.3.x** (matches `src/app-version.cjs` / sync payload) |

## Subsystem glossary

| Internal name | Scope | Key paths / concepts |
|---------------|-------|----------------------|
| **Pulse Sync** | Full-store payload to clients | `src/dal/sync-payload.cjs`, `/api/sync` |
| **Pulse Rhythm** | Daily load, board tasks, vendor expected orders | `src/lib/daily-rhythm.cjs`, `rhythm-schedule-assign.cjs` |
| **Pulse EOD** | End-of-day sweep, archive, rhythm stamp reset | `src/api.cjs` (`executeEODSweep`) |
| **Pulse Rec** | Receiving: time in/out, pallets, expected orders | `client/src/rec/`, `receiving-flow.cjs`, `expected-orders-day.cjs` |
| **Pulse Direction** | Daily Direction, shift updates, floor message | `src/lib/daily-direction.cjs` |
| **Pulse Reports** | Manager reports, labor ledger, analytics | `client/src/reports/`, `src/dal/reports-payload.cjs` |
| **Pulse Auth** | Sessions, PIN, TV/device trust | `src/auth*.cjs`, trusted devices |
| **Pulse Actions** | Table/action mutations | `src/actions/handlers.cjs`, `/api/action` |

## Where to use Pulse

**Do**

- Architecture and runbooks under `docs/pulse/`
- Commit messages: `fix(pulse-rec): …`, `feat(pulse-rhythm): …`
- Patch / release notes for dev and deploy
- Chat and ticket titles

**Do not (until an external rebrand)**

- Login screens, window titles, toolbox PDFs, TV headers
- Staff training language on the floor

## Suggested commit prefixes

```
pulse          — whole-app or cross-cutting
pulse-sync     — sync payload / client refresh
pulse-rhythm   — daily rhythm, assignments, board load
pulse-eod      — EOD sweep, archival, retention
pulse-rec      — receiving, expected orders, pallets
pulse-direction — daily direction, shift updates
pulse-reports  — reports, manager hub meta, analytics
pulse-auth     — sessions, roles, device access
```

## Repo / folder note

The workspace may still be named `TGP_V3` or similar. **Pulse** is the product name; folder renames are optional and not required for staff-facing behavior.

## Related docs

- [Documentation index](../INDEX.md)
- [AI handoff (5.3.2)](../AI_HANDOFF_TGP_V5.md)
- [Testing / chaos / Lighthouse](../TESTING.md)
- [TGP Board Toolbox Meeting](../TGP_Board_Toolbox_Meeting.md) — staff-facing walkthrough (TGP branding)
