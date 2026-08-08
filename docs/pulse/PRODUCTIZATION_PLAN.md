# Pulse — Productization Plan (Copy → Blank Slate → Shop)

**Status:** Planning only (no implementation committed)  
**Internal name:** Pulse  
**Staff-facing name:** Unchanged (TGP Centre Store until external rebrand)  
**Baseline app version for this plan:** 5.3.2 (React floor + portals; Financial Log present; TV native shell)

---

## Goal

Create a copy of the application tree that can be stripped to a **blank production slate** and packaged for other stores — without forking the codebase per tenant.

TGP Centre Store remains **Store Pack #1**, not the platform default.

---

## Three tenant profiles

| Profile | Code | Example | What changes | Difficulty |
|---------|------|---------|--------------|------------|
| TGP sibling | **B** | Another Centre Store, new city | Name, zones, vendors, staff, labor baselines | Mostly data (Store Pack) |
| Independent grocery | **A** | Different primary wholesaler (e.g. Sysco) | Order days, primary vendor, pallet rules, rhythm labels | Config + core abstractions |
| C-store / non-grocery | **C** | Convenience, hybrid retail | Module set — may disable order day, pallets, receiving | Feature toggles + pack schema |

**Unlock order:** B first (fastest), then A (first true white-label), then C (platform stretch).

---

## Architecture layers

```
Pulse Core          — auth, sync, tasks, EOD, settings, migrations, reports engine
Feature modules     — rhythm, rec, order-day, pallets, markdown, cs, safe (toggleable)
Store Pack          — per-tenant JSON + optional docs (no runtime DB)
Store Instance      — pulse_ops.db, backups, logs, staff PINs (never in template)
```

One copied folder. Three pack **profiles**. Not three codebases.

---

## Folder layout (target)

```
pulse-platform/                    # working name for shoppable copy
├── app/                           # was resources/app (Pulse Core)
├── store-packs/
│   ├── blank/                     # neutral demo slate
│   ├── tgp-centre-store/          # current default, lifted out (profile B)
│   ├── grocery-generic/           # template for profile A (Milestone 2)
│   └── c-store-minimal/           # template for profile C (Milestone 3)
└── docs/pulse/
    ├── README.md
    └── PRODUCTIZATION_PLAN.md     # this file
```

Production Centre Store (`TGP_V3`) keeps running until cutover. Template work happens in `pulse-platform/`.

---

## Store Pack contract

### Shared files (all profiles)

| File | Purpose |
|------|---------|
| `pack.json` | Profile type, feature flags, primary vendor (if any) |
| `brand.json` | Display name, default timezone, optional logo paths |
| `zone-settings.json` | Map layout, sections, heat zones |
| `rhythm-tasks.json` | Daily routine templates |
| `audit-walk-templates.json` | Safety / audit checklists |

### Grocery-heavy (profiles A + B)

| File | Purpose |
|------|---------|
| `order-cadence.json` | Primary vendor name, aliases, order weekdays |
| `vendor-schedule.json` | Delivery calendar |
| `vendor-directory.json` | Vendor contacts (placeholders in blank) |
| `vendor-aliases.json` | Canonical vendor name mapping |
| `labor-minimum-baseline.json` | Scheduled-hours comparison |
| `task-estimate-baselines.json` | Rhythm time hints |

### TGP-specific (profile B)

Current `store-templates/default/*` moved here, plus TGP SOP docs under `docs/`.

---

## `pack.json` — feature switchboard

Drives which modules load, which portals appear, and what rhythm/EOD logic runs.

### Profile B — TGP sibling (example)

```json
{
  "profile": "tgp-grocery",
  "features": {
    "rhythm": true,
    "receiving": true,
    "order_day": true,
    "pallets": true,
    "markdown": true,
    "daily_direction": true,
    "betacs": false,
    "presence": false
  },
  "primary_vendor": {
    "name": "TGP",
    "aliases": ["The Grocery People"]
  }
}
```

### Profile A — Independent grocery (example)

```json
{
  "profile": "grocery",
  "features": {
    "rhythm": true,
    "receiving": true,
    "order_day": true,
    "pallets": false,
    "markdown": true,
    "daily_direction": true,
    "betacs": false,
    "presence": false
  },
  "primary_vendor": {
    "name": "Sysco",
    "aliases": ["SYSCO Canada"]
  }
}
```

### Profile C — C-store (example)

```json
{
  "profile": "c-store",
  "features": {
    "rhythm": true,
    "receiving": false,
    "order_day": false,
    "pallets": false,
    "markdown": true,
    "daily_direction": true,
    "betacs": true,
    "presence": false
  }
}
```

---

## Module matrix (design target)

| Module | B TGP | A Grocery | C C-store |
|--------|-------|-----------|-----------|
| Mobile board / rhythm | ✓ | ✓ | ✓ lite |
| Daily Direction | ✓ | ✓ | ✓ |
| Receiving `/rec` | ✓ | ✓ | optional |
| Order day / clock | ✓ | ✓ | ✗ |
| Primary-vendor pallets | ✓ | configurable | ✗ |
| Markdown `/markdown` | ✓ | ✓ | ✓ |
| Reports / labor | ✓ | ✓ | ✓ trimmed |
| BetaCS `/cs` | optional | optional | ✓ common |
| Safety `/safe` | ✓ | ✓ | ✓ |
| Presence / TV extras | optional | optional | optional |

---

## Milestones

### Milestone 1 — Copy + strip + two packs (unlocks **B**)

- [ ] Copy tree → `pulse-platform/` (exclude `node_modules`; reinstall on build machine)
- [ ] Strip: `tgp_ops.db*`, `backups/`, logs, playwright/test caches, old resource snapshots
- [ ] Sanitize seeds: no real phone numbers, no named zone owners in blank pack
- [ ] Create `store-packs/blank/` — neutral boot (`Pulse Store`, `STORE-001`)
- [ ] Move `store-templates/default/` → `store-packs/tgp-centre-store/`
- [ ] Centre Store loads from TGP pack, not hardcoded code defaults
- [ ] Generalize `scripts/STORE_INSTANCE_SETUP.txt` → Pulse instance runbook
- [ ] `npm run verify:store` passes on blank install

**Deliverable:** Another TGP-format store via pack only (name, zones, vendors).

---

### Milestone 2 — Primary vendor + cadence config (unlocks **A**)

- [ ] `order-cadence.json` drives order weekdays and primary vendor detection
- [ ] Replace hardcoded `isTgpVendor()`, `TGP_ORDER_WEEKDAYS`, `"TGP Order"` rhythm task
- [ ] Pallet intake rules from pack (`required_for: ["primary"]` or vendor list)
- [ ] Reports / Daily Direction labels from pack (generic “Order Day” when not TGP)
- [ ] Add `store-packs/grocery-generic/` reference template
- [ ] Split `branding-labels.test.cjs` → core smoke vs pack branding

**Deliverable:** Independent grocer with different wholesaler and schedule.

---

### Milestone 3 — Module toggles + portal gating (unlocks **C**)

- [ ] `pack.json` `features.*` gates routes and sync payload sections
- [ ] Rhythm load skips vendor inserts when `receiving: false`
- [ ] Reports KPI strip hides order/receiving when modules off
- [ ] TV layout respects minimal profile
- [ ] Optional: rename `TGP_*` env → `PULSE_*`, `tgp_ops.db` → `pulse_ops.db`
- [ ] Add `store-packs/c-store-minimal/` reference template

**Deliverable:** C-store with board + markdown + CS, no freight/order-day surface.

---

### Milestone 4 — Product packaging (shop all three)

- [ ] Installer / deploy checklist per profile
- [ ] First-boot pack selection or manager “apply pack” workflow
- [ ] Verify scripts: `verify:blank`, `verify:pack <id>`
- [ ] One-pager per profile for external conversations

---

## Blank slate acceptance checklist

A template copy is ready to shop when:

- [ ] No `.db`, backup, or log with real store data in the tree
- [ ] `store-packs/blank/` boots with no named staff in zone config
- [ ] No real phone numbers in seed JSON
- [ ] Training login documented; production PIN change workflow clear
- [ ] Verify script passes on clean install
- [ ] Pack apply API/command documented for first run
- [ ] TGP Centre Store runs from `tgp-centre-store` pack, not code defaults

---

## Strip list (never ship in template)

| Item | Risk |
|------|------|
| `tgp_ops.db`, WAL/SHM | Staff, PINs, full history |
| `backups/*.db` | Full store snapshots |
| `*.log`, chaos/playwright artifacts | PII, paths, tokens |
| `test-results/`, `.playwright-staff-cache.json` | Cached auth |
| `backups/resourcesPrePatch/`, etc. | Old code + DB refs |
| `resources/Doc/standards-pdf/zone-snapshot.json` | Live staff names |
| `.env`, OCR API keys | Secrets |

---

## Core abstractions required (before A/C)

| Today (hardcoded) | Target |
|-------------------|--------|
| `isTgpVendor()` | `isPrimaryVendor(vendor, pack)` |
| `TGP_ORDER_WEEKDAYS` | `order-cadence.json` |
| TGP pallet intake required | Pack rule per vendor class |
| `"TGP Order"` task detail | Pack-defined order-day label |
| TGP cold chain export scope | Pack flag |
| `tgp_ops.db`, `TGP_*` env | Configurable prefix (optional Milestone 3) |
| `TgpApi` client namespace | `PulseApi` (cosmetic, deferrable) |

---

## What to defer

- Full HQ multi-store rollup dashboard
- Renaming every `TgpApi` reference before first B-store pilot
- Rebuilding `node_modules` on every copy (document rebuild once)
- External trademark/domain work until Milestone 4

---

## Risk summary

1. **Semantic TGP coupling** (~10% of code) blocks profiles A and C until Milestone 2–3.
2. **Tests enforce TGP branding** — must split before blank product is CI-clean.
3. **Template data leaks** — vendor phones and zone snapshots have shipped real PII before; sanitize aggressively in blank pack.

---

## Related docs

- [Pulse internal naming](./README.md)
- [TGP Board Toolbox Meeting](../TGP_Board_Toolbox_Meeting.md) — staff-facing (TGP branding)
- `scripts/STORE_INSTANCE_SETUP.txt` — current single-store setup (to generalize)
