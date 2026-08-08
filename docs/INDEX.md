# TGP / Pulse documentation index

**App version:** 5.4.5  
**Last refreshed:** 2026-08-01  
**Tree:** `resources/app` (this folder)

Use this as the map of **first-party** docs. Do not treat `node_modules/**` READMEs as product docs.

## Start here

| Doc | Purpose |
|-----|---------|
| [AI_HANDOFF_TGP_V5.md](./AI_HANDOFF_TGP_V5.md) | Full AI/dev handoff for the live codebase |
| [../CHANGELOG.md](../CHANGELOG.md) | Shipped release notes by semver |
| [../PATCH_NOTES.txt](../PATCH_NOTES.txt) | Store-facing / deploy patch bullets |
| [TESTING.md](./TESTING.md) | Chaos, Hell 3000, Lighthouse, throwaway ports |
| [pulse/README.md](./pulse/README.md) | Internal “Pulse” naming |

## Product / planning

| Doc | Purpose |
|-----|---------|
| [pulse/PRODUCTIZATION_PLAN.md](./pulse/PRODUCTIZATION_PLAN.md) | Multi-store / blank-slate packaging plan |
| [TGP_Board_Toolbox_Meeting.md](./TGP_Board_Toolbox_Meeting.md) | Staff-facing toolbox walkthrough |
| [superpowers/specs/2026-07-28-chaos-app-monkey-design.md](./superpowers/specs/2026-07-28-chaos-app-monkey-design.md) | Chaos App Monkey design |
| [superpowers/specs/2026-07-19-safe-incident-investigation-design.md](./superpowers/specs/2026-07-19-safe-incident-investigation-design.md) | Safe investigation design |
| [superpowers/plans/2026-07-19-safe-incident-investigation.md](./superpowers/plans/2026-07-19-safe-incident-investigation.md) | Safe investigation plan |

## Peer review (historical)

Exported **2026-07-27** against **v5.3.1**. Still useful for architecture context; security findings may be partially addressed in 5.3.2.

| Doc | Purpose |
|-----|---------|
| [peer-review/README.md](./peer-review/README.md) | Index |
| [peer-review/01-architecture-module-map.md](./peer-review/01-architecture-module-map.md) | Module map |
| [peer-review/02-security-reliability-review.md](./peer-review/02-security-reliability-review.md) | Ranked findings |
| [peer-review/03-peer-review-deep-dive.md](./peer-review/03-peer-review-deep-dive.md) | Scorecard synthesis |

## Runtime / TV / Cursor rules

| Doc | Purpose |
|-----|---------|
| [../public/tv/BUILD_NOTES.txt](../public/tv/BUILD_NOTES.txt) | Native vs legacy TV shells |
| [../.cursor/rules/react-floor-owner.mdc](../.cursor/rules/react-floor-owner.mdc) | React owns floor + portals |
| [../.cursor/rules/settings-react-only.mdc](../.cursor/rules/settings-react-only.mdc) | Settings UI is React-only |
| [../PATCH24_TV_READABILITY_LAYOUT.md](../PATCH24_TV_READABILITY_LAYOUT.md) | Historical TV readability patch notes |

## Generated / do not hand-edit as source of truth

- `tests/chaos-monkey-report.json`, `tests/hell3000-report.json`, `tests/chaos-infinity-run.log`
- `tests/lighthouse-reports/**` HTML/JSON outputs
- `tests/chaos/chaos_report.txt`
